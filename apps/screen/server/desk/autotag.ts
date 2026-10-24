import { ITEM_TYPES, type ItemType } from './types.js';

// A new T3 thread's type, guessed from the owner's opening message by the summarizer's small model,
// with the owner's own recently labeled threads as examples. Stages stay owner-set (owner, 10/20). A guess
// the model isn't sure of is left off, and the owner's labels always win (the desk never re-guesses).
// Measured 10/14 on 128 threads the owner had labeled: 71% right overall, 76% at confidence ≥ 0.7.

export interface AutoTagExample {
  title: string;
  opening: string;
  type: ItemType;
}

export interface AutoTagInput {
  repo: string | null;
  title: string;
  opening: string;
  examples: AutoTagExample[];
}

export type AutoTagger = (input: AutoTagInput) => Promise<{ type: ItemType; confidence: number } | null>;

/**
 * Below this the guess is kept on the item but not applied. 0.6, not 0.7 (10/15): the model scores
 * "feature or enhancement, both fit" at 0.6, and those held back left new threads unfiled; the dot
 * asks the owner to check a guess anyway. In its first day all 9 applied guesses held up.
 */
export const AUTOTAG_MIN_CONFIDENCE = 0.6;
/** How many of the owner's labeled threads go into the prompt, newest first. */
export const AUTOTAG_EXAMPLES = 60;

const DEFINITIONS = [
  'You label a new thread between the owner and a coding agent by the kind of work it is. Read the opening request and pick one type:',
  '- project: a larger initiative that likely includes many features, spanning several pieces of work',
  '- feat: a new addition that has not existed before',
  '- enh: a change that improves something that already exists (polish, extending or reworking an existing feature)',
  '- bug: something is broken or behaving wrong',
  '- chore: maintenance, cleanup, refactoring, dependencies, docs',
  '- ops: machines, infrastructure, deploys, accounts, networking, keeping systems running (not product code)',
  '- skill: writing or changing an agent skill, prompt or instructions',
  'confidence: 0 to 1, how sure you are. Use below 0.7 when two types fit about equally.',
  'Reply with JSON only: {"type": string, "confidence": number}.',
].join('\n');

const oneLine = (text: string, max: number) => text.replace(/\s+/g, ' ').trim().slice(0, max);

export function autoTagPrompt(input: AutoTagInput): { system: string; user: string } {
  const examples = input.examples.length
    ? `\n\nHow the owner has labeled recent threads (follow their habits):\n${input.examples.map((example) => `- [${example.type}] ${oneLine(example.title, 80)}: ${oneLine(example.opening, 160)}`).join('\n')}`
    : '';
  return {
    system: DEFINITIONS + examples,
    user: `${input.repo ? `Repo: ${input.repo}\n` : ''}Thread title: ${oneLine(input.title, 120)}\nOpening message:\n${input.opening.slice(0, 2500)}`,
  };
}

/** The model's reply, validated: a known type and a confidence in [0, 1], else null. */
export function parseAutoTag(raw: string): { type: ItemType; confidence: number } | null {
  try {
    const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as { type?: unknown; confidence?: unknown };
    const type = String(parsed.type ?? '').toLowerCase();
    if (!(ITEM_TYPES as readonly string[]).includes(type)) return null;
    const confidence = Number(parsed.confidence);
    return { type: type as ItemType, confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0 };
  } catch {
    return null;
  }
}

export function createAutoTagger(options: { apiKey: string; model: string; baseUrl?: string; timeoutMs?: number }): AutoTagger {
  const url = `${(options.baseUrl ?? 'https://ollama.com/v1').replace(/\/$/, '')}/chat/completions`;
  return async (input) => {
    if (!options.apiKey) return null;
    const prompt = autoTagPrompt(input);
    const response = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
      headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: options.model,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        response_format: { type: 'json_object' },
        temperature: 0,
      }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return parseAutoTag(body.choices?.[0]?.message?.content ?? '');
  };
}
