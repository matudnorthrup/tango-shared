import { randomUUID } from 'node:crypto';
import { historyCaller } from './dictation-history.js';
import type { DictationHistoryStore } from './dictation-history-store.js';

/** Flags can only suppress recording; identity always comes from the authenticated Serve edge. */
export function voiceHistoryCapture(headers: Headers, url: URL, store?: DictationHistoryStore, destination?: string) {
  const who = historyCaller(headers);
  if (!store || !who || (url.searchParams.get('mode') !== 'dictation' && !destination)
    || headers.get('origin') !== `https://${headers.get('x-forwarded-host')}`
    || (headers.has('sec-fetch-site') && headers.get('sec-fetch-site') !== 'same-origin')
    || url.searchParams.get('history') === 'off' || url.searchParams.get('manualFinish') === '1'
    || url.searchParams.get('role') === 'screen' || url.searchParams.get('detached') === '1'
    || url.searchParams.get('framed') === '1') return undefined;
  // WebSockets do not consistently send Referer. If present, it must describe the owner desk.
  if (headers.has('referer')) {
    try {
      const ref = new URL(headers.get('referer')!);
      if (ref.origin !== headers.get('origin') || !/^\/(?:tango-screen\/)?$/.test(ref.pathname)
        || ref.searchParams.get('role') === 'screen' || ref.searchParams.get('detached') === '1') return undefined;
    } catch { return undefined; }
  }
  try {
    const generation = store.list(who.owner).generation;
    const saved = new Set<number>();
    return (text: string, failed: boolean, turn = 0, sent = false) => {
      if (saved.has(turn) || !text.trim()) return;
      saved.add(turn);
      // Clear during a capture wins. A failed write is never retried with a new generation.
      try { store.put(who.owner, who.device, generation, {
        id: randomUUID(), capturedAt: Date.now(), text, destination: (destination || 'Desk dictation').slice(0, 256),
        outcome: sent ? 'sent' : failed ? 'failed' : 'unknown', revision: 1,
      }); } catch { /* Recovery must not interrupt voice, or leak text through diagnostics. */ }
    };
  } catch { return undefined; }
}
