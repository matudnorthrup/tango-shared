// People the owner talks about (operator profile `people`): speech-to-text garbles names it
// doesn't know, so each spelling it has produced is swapped for the name before an agent sees it.

export interface KnownPerson {
  name: string;
  /** Who they are ("a neighbor"), so the router can tell a name from a word it sounds like. */
  note?: string;
  /** Spellings speech-to-text has produced for them; each is replaced with the name in what agents get. */
  heardAs?: string[];
}

/** A text fixer for these people: every heard spelling (whole word, any case) becomes the name ("Zedd" → "Zed"). */
export function nameFixer(people: KnownPerson[] | undefined): (text: string) => string {
  const byHeard = new Map<string, string>();
  for (const person of people ?? []) for (const heard of person.heardAs ?? []) if (heard.trim()) byHeard.set(heard.trim().toLowerCase(), person.name);
  if (!byHeard.size) return (text) => text;
  // One pass over the original text: a replaced name is never matched again (Ann → Anne, Anne → Ana).
  const escaped = [...byHeard.keys()].sort((a, b) => b.length - a.length).map((heard) => heard.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // Whole words only, and never inside an address, link or file name ("Zed+orders@example.com", "zed.pdf").
  const pattern = new RegExp(`(?<![\\w@./+%\\\\-])(?:${escaped.join('|')})(?![\\w@/+%\\\\-]|\\.\\w)`, 'gi');
  // Words that are links, addresses or paths keep their exact text, wherever the name sits in them.
  return (text) => {
    const kept = [...text.matchAll(/\S*(?:[@/\\?=#]|:\/\/)\S*/g)].map((token) => [token.index, token.index + token[0].length]);
    return text.replace(pattern, (match, offset: number) => (kept.some(([start, end]) => offset >= start && offset < end) ? match : (byHeard.get(match.toLowerCase()) ?? match)));
  };
}
