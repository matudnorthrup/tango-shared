import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../public/desk/navigator-context.js', () => ({ navigatorContext: () => ({ place: 'Inbox', choices: [] }), executeNavigator: vi.fn() }));
// @ts-expect-error browser module
import { startNavigatorBridge } from '../public/desk/navigator-bridge.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it('only reports activity on focus or input, never on heartbeat, store updates or reconnect', () => {
  vi.useFakeTimers();
  const win = new EventTarget();
  vi.stubGlobal('window', win);
  vi.stubGlobal('location', { protocol: 'http:' });
  const sockets: MockSocket[] = [];
  class MockSocket {
    static OPEN = 1;
    readyState = 1;
    onopen?: () => void;
    onclose?: () => void;
    send = vi.fn();
    close = vi.fn();
    constructor() { sockets.push(this); }
  }
  vi.stubGlobal('WebSocket', MockSocket);
  let changed!: () => void;
  const stop = startNavigatorBridge({ state: { role: 'full' }, subscribe: (fn: () => void) => { changed = fn; return vi.fn(); } });
  try {
    const ws = sockets[0]!;
    const activity = () => JSON.parse(ws.send.mock.calls.at(-1)![0]).activity;
    ws.onopen!(); expect(activity()).toBe(false);
    for (const event of ['focus', 'pointerdown', 'keydown']) {
      win.dispatchEvent(new Event(event)); expect(activity()).toBe(true);
      vi.advanceTimersByTime(10_000); expect(activity()).toBe(false);
      changed(); vi.advanceTimersByTime(150); expect(activity()).toBe(false);
    }
    win.dispatchEvent(new Event('blur')); expect(activity()).toBe(false);
    ws.onclose!(); vi.advanceTimersByTime(3000);
    sockets[1]!.onopen!();
    expect(JSON.parse(sockets[1]!.send.mock.calls[0]![0]).activity).toBe(false);
  } finally { stop(); }
  expect(vi.getTimerCount()).toBe(0);
});
