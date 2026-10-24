import { textSummary } from './inbox-summarize.js';

// Topics in an agent's chat (its home channel). A thread is already one topic;
// a chat is a stream where several topics interleave and come and go ("food
// tracking today", "Bike turn signal"). Each new message that doesn't have an
// obvious home is filed by a small model: it continues one of the agent's open
// topics, or starts a new one with a short title.

export interface TopicCandidate {
  id: string;
  title: string;
  /** Where it stands (the item's one-line summary). */
  standing: string;
  lastActivityAt: number;
  /** The last couple of messages, oldest first. */
  recent: Array<{ author: 'agent' | 'owner' | 'other'; text: string }>;
}

export interface TopicInput {
  agentName: string;
  message: { author: 'agent' | 'owner'; text: string; at: number };
  candidates: TopicCandidate[];
}

export interface TopicDecision {
  /** A candidate's id, or null for a new topic. */
  topicId: string | null;
  /** Title for a new topic (short, specific). */
  title: string;
  /** The owner is wrapping the topic up ("that's everything for today, thanks"). */
  wrapsUp: boolean;
  source: 'model' | 'fallback';
}

export type TopicAssigner = (input: TopicInput) => Promise<TopicDecision>;

/** Without a model: continue the most recent open topic if it was active in the last two hours. */
export function fallbackTopic(input: TopicInput): TopicDecision {
  const recent = [...input.candidates].sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
  if (recent && input.message.at - recent.lastActivityAt < 2 * 3_600_000) {
    return { topicId: recent.id, title: recent.title, wrapsUp: false, source: 'fallback' };
  }
  return { topicId: null, title: textSummary(input.message.text, 48), wrapsUp: false, source: 'fallback' };
}

export function createOllamaTopicAssigner(options: { apiKey: string; model: string; baseUrl?: string; timeoutMs?: number }): TopicAssigner {
  const url = `${(options.baseUrl ?? 'https://ollama.com/v1').replace(/\/$/, '')}/chat/completions`;
  return async (input) => {
    if (!options.apiKey) return fallbackTopic(input);
    const who = (author: string) => (author === 'agent' ? input.agentName : author === 'owner' ? 'Owner' : 'Someone');
    // Short handles: models pick "T2" far more reliably than a long id.
    const handle = (index: number) => `T${index + 1}`;
    const candidates = input.candidates.length
      ? input.candidates
          .map(
            (candidate, index) =>
              `- ${handle(index)}: "${candidate.title}" (${candidate.standing || 'no summary yet'}; last active ${Math.max(1, Math.round((input.message.at - candidate.lastActivityAt) / 60_000))} min ago)\n` +
              candidate.recent.map((message) => `    ${who(message.author)}: ${message.text.replace(/\s+/g, ' ').slice(0, 220)}`).join('\n'),
          )
          .join('\n')
      : '(none)';
    const prompt = [
      `The owner chats with ${input.agentName} in one ongoing channel where several topics interleave. File the new message under a topic.`,
      '',
      `Open topics:\n${candidates}`,
      '',
      `New message from ${who(input.message.author)}: ${input.message.text.slice(0, 1500)}`,
      '',
      'topic: the handle (T1, T2, …) of the open topic this message continues (same specific subject: the same day\'s food logging, the same repair, the same purchase decision), or null if it starts something new. A different subject in the same general area is a new topic. If you would title it the same as an open topic, it IS that topic: return its handle.',
      'A follow-up that builds on a topic\'s latest exchange continues that topic even when it asks a new question: it refers back to what was just said or done ("based on the schedule…", "how does this change if…", "also move my lunch"), usually minutes later. Only a clearly unrelated subject starts a new topic mid-conversation.',
      'title: for a new topic, 2-5 words naming the subject ("Food tracking", "Bike turn signal", "Coffee subscription"); for a continued topic, its existing title.',
      'wraps_up: true only if the owner is clearly closing the subject ("that\'s everything for today", "all set, thanks").',
      'Reply with JSON only: {"topic": string|null, "title": string, "wraps_up": boolean}.',
    ].join('\n');
    try {
      const response = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
        headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: options.model,
          messages: [
            { role: 'system', content: 'You file chat messages into topics. Reply with JSON only.' },
            { role: 'user', content: prompt },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.1,
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const raw = body.choices?.[0]?.message?.content ?? '';
      const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as { topic?: string | null; title?: string; wraps_up?: boolean };
      const picked = typeof parsed.topic === 'string' ? /^T(\d+)$/i.exec(parsed.topic.trim()) : null;
      const byHandle = picked ? input.candidates[Number(picked[1]) - 1] : undefined;
      const byId = input.candidates.find((candidate) => candidate.id === parsed.topic);
      const title = (parsed.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || textSummary(input.message.text, 48);
      // Same title as an open topic means the same topic, whatever the model put in `topic`.
      const byTitle = input.candidates.find((candidate) => candidate.title.trim().toLowerCase() === title.toLowerCase());
      const topicId = (byHandle ?? byId ?? byTitle)?.id ?? null;
      return { topicId, title, wrapsUp: parsed.wraps_up === true, source: 'model' };
    } catch {
      return fallbackTopic(input);
    }
  };
}
