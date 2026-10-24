import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createDecisionClient,
  createDecisionShadow,
  decodeDecisionAnswers,
  DecisionRequestError,
  type DecisionPrompt,
} from "../src/decision-model.js";

const prompt: DecisionPrompt = {
  state: { utterance: "log two eggs for breakfast" },
  questions: {
    agent: { type: "choice", instructions: "Which assistant?", criteria: { food: "Food logging", travel: "Travel", none: null } },
    addressed: { type: "binary", instructions: "Is an assistant being addressed?" },
    urgency: { type: "score", instructions: "How soon?", criteria: ["Can wait", "Today"] },
  },
};

const payload = {
  model: "typesafe/jev-1.13-20260917",
  answers: {
    agent: { type: "choice", choice: "food", confidence: 0.97, probabilities: { food: 0.97, travel: 0.02, none: 0.01 } },
    addressed: { type: "noul", noul: 0.81 },
    urgency: { type: "score", score: 0.3, confidence: 0.7, probabilities: { "0": 0.7, "1": 0.3 } },
  },
  usage: { input_tokens: 120, output_tokens: 9 },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("decodeDecisionAnswers", () => {
  it("decodes every question type", () => {
    expect(decodeDecisionAnswers(payload, prompt)).toEqual({
      agent: { type: "choice", choice: "food", confidence: 0.97, probabilities: { food: 0.97, travel: 0.02, none: 0.01 } },
      addressed: { type: "binary", probability: 0.81 },
      urgency: { type: "score", score: 0.3, confidence: 0.7, probabilities: { "0": 0.7, "1": 0.3 } },
    });
  });

  it("rejects a choice outside the asked options", () => {
    const bad = structuredClone(payload);
    bad.answers.agent.choice = "finance";
    expect(() => decodeDecisionAnswers(bad, prompt)).toThrow("Invalid choice decision: agent");
  });

  it("rejects probabilities that do not cover every option", () => {
    const bad = structuredClone(payload) as typeof payload & { answers: { agent: { probabilities: Record<string, number> } } };
    delete bad.answers.agent.probabilities.none;
    expect(() => decodeDecisionAnswers(bad, prompt)).toThrow("Incomplete probabilities: agent");
  });

  it("rejects a score missing a probability level", () => {
    const bad = structuredClone(payload) as typeof payload & { answers: { urgency: { probabilities: Record<string, number> } } };
    delete bad.answers.urgency.probabilities["1"];
    expect(() => decodeDecisionAnswers(bad, prompt)).toThrow("Incomplete probabilities: urgency");
  });

  it("rejects a missing answer", () => {
    const bad = structuredClone(payload) as { answers: Record<string, unknown> };
    delete bad.answers.addressed;
    expect(() => decodeDecisionAnswers(bad, prompt)).toThrow("Missing decision: addressed");
  });
});

describe("createDecisionClient", () => {
  it("sends noul for binary questions with zero data retention and selects decisions", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(payload));
    const client = createDecisionClient({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await client.decide(prompt);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    expect(body.model).toBe("typesafe/jev-1.13");
    expect(body.provider).toEqual({ zdr: true });
    expect(body.questions.addressed.type).toBe("noul");
    expect(result.decisions).toEqual({ agent: "food", addressed: true, urgency: 0.3 });
    expect(result.inputTokens).toBe(120);
    expect(result.model).toBe("typesafe/jev-1.13-20260917");
  });

  it("cools down after a spent cap and stops calling", async () => {
    let clock = 0;
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: "limit" } }, 402));
    const client = createDecisionClient({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch, now: () => clock });
    await expect(client.decide(prompt)).rejects.toMatchObject({ statusCode: 402 });
    expect(client.coolingDown()).toBe(true);
    await expect(client.decide(prompt)).rejects.toBeInstanceOf(DecisionRequestError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    clock += 31 * 60_000;
    expect(client.coolingDown()).toBe(false);
  });

  it("does not cool down on a server error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 503));
    const client = createDecisionClient({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.decide(prompt)).rejects.toMatchObject({ statusCode: 503 });
    expect(client.coolingDown()).toBe(false);
  });
});

describe("createDecisionShadow", () => {
  const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "decision-shadow-"));
  const read = (dir: string) =>
    fs.readdirSync(dir).flatMap((file) => fs.readFileSync(path.join(dir, file), "utf8").trim().split("\n").map((line) => JSON.parse(line)));

  it("logs both answers and agreement", async () => {
    const dir = tempDir();
    const client = createDecisionClient({ apiKey: "k", fetchImpl: (async () => jsonResponse(payload)) as unknown as typeof fetch });
    const shadow = createDecisionShadow({ client, logDir: dir, now: () => new Date("2026-10-07T12:00:00Z") });
    shadow.run({ site: "test.agent", prompt, incumbent: { agent: "food" }, excerpt: "log two eggs" });
    shadow.run({ site: "test.agent", prompt, incumbent: { agent: "travel" } });
    await shadow.flush();
    const rows = read(dir);
    expect(fs.readdirSync(dir)).toEqual(["shadow-2026-10-07.jsonl"]);
    expect(rows.map((row) => row.agree)).toEqual([true, false]);
    expect(rows[0]).toMatchObject({ site: "test.agent", decision: { agent: "food" }, confidence: { agent: 0.97, addressed: 0.81 }, excerpt: "log two eggs", inputTokens: 120 });
    // Only the compared question sets the confidence cohort, not the ones riding along.
    expect(rows[0].comparedConfidence).toBe(0.97);
    // A judge later needs what Jev saw.
    expect(rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rows[0].state).toEqual(prompt.state);
    expect(Object.keys(rows[0].questions)).toEqual(["agent", "addressed", "urgency"]);
  });

  it("logs errors instead of throwing, and does nothing without a client", async () => {
    const dir = tempDir();
    const failing = createDecisionClient({ apiKey: "k", fetchImpl: (async () => { throw new Error("offline"); }) as unknown as typeof fetch });
    const shadow = createDecisionShadow({ client: failing, logDir: dir });
    expect(() => shadow.run({ site: "s", prompt, incumbent: {} })).not.toThrow();
    await shadow.flush();
    expect(read(dir)[0]).toMatchObject({ site: "s", error: "offline" });

    const off = createDecisionShadow({ client: null, logDir: path.join(dir, "off") });
    off.run({ site: "s", prompt, incumbent: {} });
    await off.flush();
    expect(fs.existsSync(path.join(dir, "off"))).toBe(false);
  });

  it("drops calls beyond the in-flight limit", async () => {
    const dir = tempDir();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchImpl = vi.fn(async () => { await gate; return jsonResponse(payload); });
    const client = createDecisionClient({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });
    const shadow = createDecisionShadow({ client, logDir: dir, maxInFlight: 1 });
    shadow.run({ site: "s", prompt, incumbent: { agent: "food" } });
    shadow.run({ site: "s", prompt, incumbent: { agent: "food" } });
    release();
    await shadow.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
