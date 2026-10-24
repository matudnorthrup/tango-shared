import { randomUUID } from 'node:crypto';
import { readCodexAuth } from './codex-live-client.js';

// One small text-model call, billed either to the OpenAI API key or to a
// ChatGPT subscription (the Codex backend, same login as the voice route).

export interface ResponsesRequest {
  instructions: string;
  input: Array<{ role: 'user' | 'assistant'; text: string }>;
  /** JSON schema for structured output; omit for plain text. */
  schema?: { name: string; schema: Record<string, unknown> };
}

export type ResponsesCaller = (request: ResponsesRequest) => Promise<string>;

function body(model: string, request: ResponsesRequest, extra: Record<string, unknown>) {
  return JSON.stringify({
    model,
    instructions: request.instructions,
    input: request.input.map((turn) => ({
      type: 'message',
      role: turn.role,
      content: [{ type: turn.role === 'assistant' ? 'output_text' : 'input_text', text: turn.text }],
    })),
    reasoning: { effort: 'low' },
    ...(request.schema ? { text: { format: { type: 'json_schema', strict: true, ...request.schema } } } : {}),
    ...extra,
  });
}

export function createApiResponsesCaller(options: { apiKey: string; model?: string }): ResponsesCaller {
  return async (request) => {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
      body: body(options.model ?? 'gpt-6-luna', request, {}),
    });
    if (!response.ok) throw new Error(`responses HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const parsed = (await response.json()) as { output?: Array<{ content?: Array<{ type: string; text?: string }> }> };
    const text = parsed.output?.flatMap((item) => item.content ?? []).find((part) => part.type === 'output_text')?.text;
    if (!text) throw new Error('responses returned no text');
    return text;
  };
}

/** Uses the ChatGPT login in <codexHome>/auth.json. This backend only streams. */
export function createCodexResponsesCaller(options: { codexHome?: string; model?: string } = {}): ResponsesCaller {
  return async (request) => {
    const auth = readCodexAuth(options.codexHome);
    const response = await fetch('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'chatgpt-account-id': auth.accountId,
        'OpenAI-Beta': 'responses=experimental',
        originator: 'codex_cli_rs',
        session_id: randomUUID(),
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: body(options.model ?? 'gpt-6-luna', request, { stream: true, store: false }),
    });
    if (!response.ok) throw new Error(`codex responses HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    let text = '';
    for (const line of (await response.text()).split('\n')) {
      if (!line.startsWith('data:')) continue;
      try {
        const event = JSON.parse(line.slice(5)) as { type?: string; delta?: string };
        if (event.type === 'response.output_text.delta' && event.delta) text += event.delta;
      } catch {
        // Keep-alives and partial lines.
      }
    }
    if (!text) throw new Error('codex responses returned no text');
    return text;
  };
}

/** "api" or "codex[:CODEX_HOME]", matching the voice route flag. */
export function resolveResponsesCaller(spec: string, apiKey: string): ResponsesCaller {
  if (spec === 'codex' || spec.startsWith('codex:')) {
    return createCodexResponsesCaller({ codexHome: spec.includes(':') ? spec.slice(spec.indexOf(':') + 1) : undefined });
  }
  return createApiResponsesCaller({ apiKey });
}
