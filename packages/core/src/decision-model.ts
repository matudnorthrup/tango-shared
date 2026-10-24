// Decision models ("System One"): typed questions about a state, answered with calibrated
// probabilities instead of text. TypeSafe's Jev through OpenRouter's decisions endpoint, the
// same route a production text-decisions service uses. A decision call costs only
// input tokens (~$0.04/M) and answers in ~0.3 s including the network, so it can run beside an
// LLM classifier on every turn.
//
// Response validation follows the production adapter: every choice must be one of the asked
// options, probabilities must cover every option, nothing is normalized or repaired. A bad
// payload is an error, never a guess.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveConfiguredPath, resolveTangoProfileDataDir } from "./runtime-paths.js";

export const DEFAULT_DECISION_MODEL = "typesafe/jev-1.13";
export const DEFAULT_DECISION_URL = "https://openrouter.ai/api/alpha/decisions";

export type DecisionQuestion =
  // Binary criteria describe both sides or neither: the API rejects a one-sided pair.
  | { type: "binary"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: string[] };

export interface DecisionPrompt {
  state: unknown;
  questions: Record<string, DecisionQuestion>;
}

export type DecisionAnswer =
  | { type: "binary"; probability: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "score"; score: number; confidence: number; probabilities: Record<string, number> };

export interface DecisionResult {
  model: string;
  answers: Record<string, DecisionAnswer>;
  /** Binary → probability > yesThreshold; choice → the argmax; score → the expected level. */
  decisions: Record<string, boolean | string | number>;
  inputTokens: number;
  latencyMs: number;
}

export class DecisionRequestError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = "DecisionRequestError";
  }
}

export interface DecisionClientOptions {
  apiKey: string;
  model?: string;
  url?: string;
  timeoutMs?: number;
  yesThreshold?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface DecisionClient {
  readonly model: string;
  decide(prompt: DecisionPrompt, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<DecisionResult>;
  /** True while a cap / auth / rate-limit failure is cooling down; callers skip the call. */
  coolingDown(): boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isProbability = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

/** Validates a decisions payload against the questions asked. Exposed for tests. */
export function decodeDecisionAnswers(payload: unknown, prompt: DecisionPrompt): Record<string, DecisionAnswer> {
  if (!isRecord(payload) || !isRecord(payload.answers)) throw new Error("Invalid decision response envelope");
  const answers: Record<string, DecisionAnswer> = {};
  for (const [key, question] of Object.entries(prompt.questions)) {
    const answer = payload.answers[key];
    if (!isRecord(answer)) throw new Error(`Missing decision: ${key}`);
    if (question.type === "binary") {
      if (answer.type !== "noul" || !isProbability(answer.noul)) throw new Error(`Invalid binary decision: ${key}`);
      answers[key] = { type: "binary", probability: answer.noul };
      continue;
    }
    if (!isProbability(answer.confidence) || !isRecord(answer.probabilities)) throw new Error(`Invalid ${question.type} decision: ${key}`);
    const allowed = question.type === "choice" ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index));
    const probabilities: Record<string, number> = {};
    for (const [option, probability] of Object.entries(answer.probabilities)) {
      if (!allowed.includes(option) || !isProbability(probability)) throw new Error(`Invalid probability: ${key}.${option}`);
      probabilities[option] = probability;
    }
    // Every option or level carries a probability: a truncated distribution is not evidence.
    if (Object.keys(probabilities).length !== allowed.length) throw new Error(`Incomplete probabilities: ${key}`);
    if (question.type === "choice") {
      if (answer.type !== "choice" || typeof answer.choice !== "string" || !allowed.includes(answer.choice)) {
        throw new Error(`Invalid choice decision: ${key}`);
      }
      answers[key] = { type: "choice", choice: answer.choice, confidence: answer.confidence, probabilities };
    } else {
      if (answer.type !== "score" || typeof answer.score !== "number" || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > allowed.length - 1) {
        throw new Error(`Invalid score decision: ${key}`);
      }
      answers[key] = { type: "score", score: answer.score, confidence: answer.confidence, probabilities };
    }
  }
  return answers;
}

// A spent daily cap (402) or a bad key (401/403) won't fix itself in seconds: stop calling for a
// while instead of failing every turn. A rate limit (429) cools down briefly.
const COOLDOWN_MS: Record<number, number> = { 401: 30 * 60_000, 402: 30 * 60_000, 403: 30 * 60_000, 429: 60_000 };

export function createDecisionClient(options: DecisionClientOptions): DecisionClient {
  const model = options.model ?? DEFAULT_DECISION_MODEL;
  const url = options.url ?? DEFAULT_DECISION_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const yesThreshold = options.yesThreshold ?? 0.5;
  let coolUntil = 0;

  return {
    model,
    coolingDown: () => now() < coolUntil,
    async decide(prompt, callOptions = {}) {
      if (now() < coolUntil) throw new DecisionRequestError("Decision model cooling down after a cap, auth or rate-limit failure", 0);
      const questions = Object.fromEntries(
        Object.entries(prompt.questions).map(([key, question]) => [key, question.type === "binary" ? { ...question, type: "noul" } : question]),
      );
      const timeout = AbortSignal.timeout(callOptions.timeoutMs ?? options.timeoutMs ?? 5000);
      const signal = callOptions.signal ? AbortSignal.any([callOptions.signal, timeout]) : timeout;
      const started = now();
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          signal,
          headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
          // Zero data retention: owner conversations never stay with the provider.
          body: JSON.stringify({ model, state: prompt.state, questions, provider: { zdr: true } }),
        });
      } catch (error) {
        throw new DecisionRequestError(error instanceof Error ? error.message : String(error), 0);
      }
      if (!response.ok) {
        const cooldown = COOLDOWN_MS[response.status];
        if (cooldown) coolUntil = now() + cooldown;
        const detail = (await response.text().catch(() => "")).slice(0, 200);
        throw new DecisionRequestError(`Decision request failed: HTTP ${response.status} ${detail}`.trim(), response.status);
      }
      const payload = (await response.json()) as unknown;
      const answers = decodeDecisionAnswers(payload, prompt);
      const decisions: DecisionResult["decisions"] = {};
      for (const [key, answer] of Object.entries(answers)) {
        decisions[key] = answer.type === "binary" ? answer.probability > yesThreshold : answer.type === "choice" ? answer.choice : answer.score;
      }
      const usage = isRecord(payload) && isRecord(payload.usage) ? payload.usage : {};
      return {
        model: isRecord(payload) && typeof payload.model === "string" ? payload.model : model,
        answers,
        decisions,
        inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
        latencyMs: now() - started,
      };
    },
  };
}

// ── shadow mode ─────────────────────────────────────────────────────────────
//
// A shadow decision runs beside the classifier that actually decides, never instead of it: it is
// fire-and-forget, can't throw into the caller, and only appends one JSONL line per call (both
// answers, Jev's confidence, whether they agree, and the state and questions Jev saw).
// Agreement is not accuracy: the deciding classifier has bugs too. `scripts/decisions-adjudicate.mjs`
// has a judge rule on each row, blind to which system answered and with what happened next, and
// `scripts/decisions-shadow-report.mjs` scores both systems against those rulings.

export interface DecisionShadowEntry {
  at: string;
  site: string;
  model?: string;
  latencyMs?: number;
  inputTokens?: number;
  incumbent: Record<string, unknown>;
  decision?: Record<string, boolean | string | number>;
  confidence?: Record<string, number>;
  /** The lowest confidence among the questions the agreement rule compares. */
  comparedConfidence?: number;
  agree?: boolean;
  error?: string;
  /** A short excerpt of what was judged, so disagreements can be labelled by hand. */
  excerpt?: string;
  /** Row id, for adjudications. */
  id?: string;
  /** What Jev saw (state, clipped) and the questions with their options, so a judge sees the same. */
  state?: unknown;
  questions?: DecisionPrompt["questions"];
  /** Pointers a judge uses to find what happened next (e.g. the desk item id). */
  meta?: Record<string, string | number | null>;
}

export interface DecisionShadowRun {
  site: string;
  prompt: DecisionPrompt;
  /** What the deciding classifier chose, in the same keys as `decisions` where they compare. */
  incumbent: Record<string, unknown>;
  /** Agreement rule; defaults to every incumbent key equal to Jev's decision of the same key. */
  agree?: (decisions: DecisionResult["decisions"], incumbent: Record<string, unknown>) => boolean;
  /** The questions `agree` compares, for confidence cohorts; defaults to the incumbent's keys. */
  compared?: string[];
  excerpt?: string;
  meta?: Record<string, string | number | null>;
}

export interface DecisionShadow {
  run(entry: DecisionShadowRun): void;
  /** Resolves once every in-flight shadow call has logged. For tests and shutdown. */
  flush(): Promise<void>;
}

export interface DecisionShadowOptions {
  client: DecisionClient | null;
  logDir: string;
  /** Concurrent shadow calls beyond this are dropped, so a burst never queues work. */
  maxInFlight?: number;
  now?: () => Date;
  onError?: (error: unknown) => void;
}

function confidences(answers: Record<string, DecisionAnswer>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(answers).map(([key, answer]) => [key, answer.type === "binary" ? Math.max(answer.probability, 1 - answer.probability) : answer.confidence]),
  );
}

const MAX_STATE_CHARS = 12_000;

/** The state as logged: whole when small, else its JSON clipped (the judge sees what fits). */
function clipState(state: unknown): unknown {
  const json = JSON.stringify(state) ?? "";
  return json.length <= MAX_STATE_CHARS ? state : `${json.slice(0, MAX_STATE_CHARS)}…`;
}

export function createDecisionShadow(options: DecisionShadowOptions): DecisionShadow {
  const inFlight = new Set<Promise<void>>();
  const maxInFlight = options.maxInFlight ?? 4;
  const now = options.now ?? (() => new Date());
  const write = (entry: DecisionShadowEntry) => {
    try {
      fs.mkdirSync(options.logDir, { recursive: true });
      fs.appendFileSync(path.join(options.logDir, `shadow-${entry.at.slice(0, 10)}.jsonl`), `${JSON.stringify(entry)}\n`);
    } catch (error) {
      options.onError?.(error);
    }
  };
  return {
    run(run) {
      const client = options.client;
      if (!client || client.coolingDown() || inFlight.size >= maxInFlight) return;
      const at = now().toISOString();
      const base = {
        id: randomUUID(),
        at,
        site: run.site,
        incumbent: run.incumbent,
        ...(run.excerpt ? { excerpt: run.excerpt.slice(0, 400) } : {}),
        state: clipState(run.prompt.state),
        questions: run.prompt.questions,
        ...(run.meta ? { meta: run.meta } : {}),
      };
      const task = client
        .decide(run.prompt)
        .then((result) => {
          const agree = run.agree
            ? run.agree(result.decisions, run.incumbent)
            : Object.entries(run.incumbent).every(([key, value]) => result.decisions[key] === value);
          const confidence = confidences(result.answers);
          const compared = (run.compared ?? Object.keys(run.incumbent)).filter((key) => key in confidence);
          const comparedConfidence = compared.length ? Math.min(...compared.map((key) => confidence[key]!)) : undefined;
          write({ ...base, model: result.model, latencyMs: result.latencyMs, inputTokens: result.inputTokens, decision: result.decisions, confidence, comparedConfidence, agree });
        })
        .catch((error: unknown) => {
          write({ ...base, error: error instanceof Error ? error.message.slice(0, 200) : String(error) });
          options.onError?.(error);
        })
        .finally(() => inFlight.delete(task));
      inFlight.add(task);
    },
    async flush() {
      await Promise.all([...inFlight]);
    },
  };
}

/**
 * The process-wide shadow from the environment: on when OPENROUTER_API_KEY is set, off with
 * TANGO_DECISION_SHADOW=off. Model via TANGO_DECISION_MODEL; log under the profile's
 * data/decisions/ (or TANGO_DECISION_LOG_DIR).
 */
export function createDecisionShadowFromEnv(env: NodeJS.ProcessEnv = process.env): DecisionShadow {
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  const enabled = (env.TANGO_DECISION_SHADOW ?? "on").trim().toLowerCase() !== "off";
  const client = apiKey && enabled ? createDecisionClient({ apiKey, model: env.TANGO_DECISION_MODEL?.trim() || undefined }) : null;
  return createDecisionShadow({
    client,
    logDir: env.TANGO_DECISION_LOG_DIR?.trim() ? resolveConfiguredPath(env.TANGO_DECISION_LOG_DIR) : path.join(resolveTangoProfileDataDir(), "decisions"),
  });
}

let processShadow: DecisionShadow | null = null;

/** One shared shadow per process, built from the environment on first use. */
export function getDecisionShadow(): DecisionShadow {
  processShadow ??= createDecisionShadowFromEnv();
  return processShadow;
}
