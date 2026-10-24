// One-line inbox summaries from a small model, plus the call that decides
// whether a new exchange continues an open item. Everything here has a
// deterministic fallback: a dead model never blocks the inbox.

export interface SummaryInput {
  agentName: string;
  place: string | null;
  /** Recent messages, oldest first. */
  messages: Array<{ author: 'agent' | 'owner' | 'other'; text: string }>;
  /** Open items from the same agent this one might continue. */
  candidates?: Array<{ id: string; summary: string }>;
}

export interface SummaryResult {
  summary: string;
  needsYou: boolean;
  /** Id of a candidate this exchange continues, if any. */
  continues: string | null;
  source: 'model' | 'text';
}

export type Summarizer = (input: SummaryInput) => Promise<SummaryResult>;

/** A question near the end of the agent's last message means it is waiting on the owner. */
export function asksOwner(text: string): boolean {
  return /\?/.test(text.slice(-240));
}

/** First sentence, trimmed to fit a row. */
export function textSummary(text: string, max = 110): string {
  const clean = text.replace(/[*_`#>~|]/g, '').replace(/\s+/g, ' ').trim();
  const sentence = /^(.{20,}?[.!?])(\s|$)/.exec(clean)?.[1] ?? clean;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

function fallback(input: SummaryInput): SummaryResult {
  const last = [...input.messages].reverse().find((message) => message.author === 'agent')?.text ?? input.messages.at(-1)?.text ?? '';
  return { summary: textSummary(last) || '(no text)', needsYou: asksOwner(last), continues: null, source: 'text' };
}

export function createOllamaSummarizer(options: { apiKey: string; model: string; baseUrl?: string; timeoutMs?: number }): Summarizer {
  const url = `${(options.baseUrl ?? 'https://ollama.com/v1').replace(/\/$/, '')}/chat/completions`;
  return async (input) => {
    if (!options.apiKey) return fallback(input);
    const transcript = input.messages
      .slice(-6)
      .map((message) => `${message.author === 'agent' ? input.agentName : message.author === 'owner' ? 'Owner' : 'Someone'}: ${message.text.slice(0, 1500)}`)
      .join('\n\n');
    const candidates = input.candidates?.length
      ? `\n\nOpen items from ${input.agentName} this might continue:\n${input.candidates.map((candidate) => `- ${candidate.id}: ${candidate.summary}`).join('\n')}`
      : '';
    const prompt = [
      `Write the inbox line for this conversation with ${input.agentName}${input.place ? ` in the "${input.place}" thread` : ''}.`,
      'summary: one line, at most 90 characters, plain text, no agent name. Lead with the topic, then where it stands or what is needed (e.g. "Bike speaker: Pioneer pick, wants OK to check button support"). Describe where things stand NOW: the latest agent message matters most; earlier messages are context.',
      'needs_you: true only if the latest agent message asks the owner a question or waits on a decision.',
      candidates
        ? 'continues: the id of an open item this is clearly the same topic as, else null. Only same specific topic, not same general area.'
        : 'continues: null.',
      'Reply with JSON only: {"summary": string, "needs_you": boolean, "continues": string|null}.',
      '',
      transcript + candidates,
    ].join('\n');
    try {
      const response = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
        headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: options.model,
          messages: [
            { role: 'system', content: 'You write terse inbox lines. Reply with JSON only.' },
            { role: 'user', content: prompt },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.1,
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const raw = body.choices?.[0]?.message?.content ?? '';
      const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as { summary?: string; needs_you?: boolean; continues?: string | null };
      const summary = (parsed.summary ?? '').replace(/\s+/g, ' ').trim();
      if (!summary) throw new Error('empty summary');
      const continues = parsed.continues && input.candidates?.some((candidate) => candidate.id === parsed.continues) ? parsed.continues : null;
      return { summary: summary.slice(0, 120), needsYou: parsed.needs_you === true, continues, source: 'model' };
    } catch {
      return fallback(input);
    }
  };
}
