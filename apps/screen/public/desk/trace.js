// What this screen rendered, for the desk's session trace (POST /api/desk/trace, source
// "screen"). Fire and forget: batched, at most one post every 500 ms, and switched off
// for good if the service doesn't have the endpoint. Never throws into the UI.

/**
 * @param {{ send: (entries: object[]) => Promise<unknown>, intervalMs?: number, maxBuffer?: number,
 *           now?: () => number, setTimer?: (fn: () => void, ms: number) => unknown }} options
 */
export function createTraceReporter({ send, intervalMs = 500, maxBuffer = 50, now = Date.now, setTimer = (fn, ms) => setTimeout(fn, ms) }) {
  let buffer = [];
  let timer = null;
  let inFlight = false;
  let lastSent = -Infinity;
  let disabled = !send;

  function schedule() {
    if (timer || inFlight || disabled || buffer.length === 0) return;
    const wait = Math.max(0, lastSent + intervalMs - now());
    timer = setTimer(() => {
      timer = null;
      void flush();
    }, wait);
  }

  async function flush() {
    if (inFlight || disabled || buffer.length === 0) return;
    const batch = buffer.splice(0, maxBuffer);
    inFlight = true;
    lastSent = now();
    try {
      await send(batch);
    } catch (err) {
      // No endpoint (an older service) or not allowed: stop trying. Anything else: this batch is lost.
      if (err && (err.status === 404 || err.status === 403 || err.status === 405)) {
        disabled = true;
        buffer = [];
      }
    } finally {
      inFlight = false;
      schedule();
    }
  }

  return {
    /** Queues one entry: `{ kind, summary, data }` (source "screen" is added). */
    report(entry) {
      try {
        if (disabled) return;
        buffer.push({ source: 'screen', ...entry, at: now() });
        if (buffer.length > maxBuffer) buffer.splice(0, buffer.length - maxBuffer);
        schedule();
      } catch {
        /* tracing never breaks the desk */
      }
    },
    flush,
    get pending() {
      return buffer.length;
    },
    get disabled() {
      return disabled;
    },
  };
}

/** What is on this screen, as one comparable key: a change is worth one trace entry. */
export function renderKey(presentation, scene) {
  const p = presentation || {};
  if (p.view === 'screen') return `screen:${p.sceneId || '-'}@${scene ? scene.version : '?'}`;
  if (p.view === 'conversation') return `conversation:${p.itemId || p.conversationKey || '-'}`;
  if (p.view === 'prototype') return `prototype:${p.prototypeId || '-'}@${p.prototype ? p.prototype.version : '?'}`;
  return 'active';
}

/** "board", "conversation Sierra · Speaker", "screen “The loop map” v2" for the trace line. */
export function renderLine(presentation, { scene = null, item = null } = {}) {
  const p = presentation || {};
  if (p.view === 'screen') {
    if (!scene) return `screen ${p.sceneId || '(no scene)'} (loading or gone)`;
    return `screen “${clip(scene.title || scene.summary || scene.id, 50)}” v${scene.version}${scene.agentName ? ` (${scene.agentName})` : ''}`;
  }
  if (p.view === 'conversation') {
    const what = item ? `${item.agentName}${item.place ? ` · ${clip(item.place, 40)}` : ''}` : p.itemId || p.conversationKey || '?';
    return `conversation ${what}`;
  }
  if (p.view === 'prototype') {
    const proto = p.prototype;
    if (!proto) return `prototype ${p.prototypeId || '(none)'} (loading or gone)`;
    return `prototype “${clip(proto.title || proto.name || proto.id, 50)}” v${proto.version}${proto.agentName ? ` (${proto.agentName})` : ''}`;
  }
  return 'board';
}

/** Error toasts are tagged so they stand out in the trace. */
export function toastKind(text) {
  return /didn[’']t|couldn[’']t|failed|may have sent|error|not reach|unreachable/i.test(text || '') ? 'toast.error' : 'toast';
}

function clip(text, max) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
