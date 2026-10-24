import { navigatorContext, executeNavigator } from './navigator-context.js';

/** No microphone: this connection only offers the current catalog and executes confirmed tickets. */
export function startNavigatorBridge(store, { name = 'Desk window' } = {}) {
  let socket, retry, stopped = false;
  const seen = new Set();
  const send = value => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };
  const update = (activity = false) => send({ type: 'context', name, role: store.state.role, activity: activity === true, context: navigatorContext(store) });
  const focus = () => update(true);
  const blur = () => update();
  function connect() {
    const url = new URL('../api/desk/navigator/bridge', import.meta.url);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(url);
    socket.onopen = () => update();
    socket.onmessage = async ({ data }) => {
      let event;
      try { event = JSON.parse(data); } catch { return; }
      if (event.type !== 'execute' || typeof event.ticket !== 'string' || seen.has(event.ticket)) return;
      seen.add(event.ticket);
      if (seen.size > 100) seen.delete(seen.values().next().value);
      const connection = socket;
      let ok = false;
      try {
        if (JSON.stringify(navigatorContext(store)) === JSON.stringify(event.context) && store.state.role !== 'screen' && !new URL(location.href).searchParams.has('detached')) {
          ok = await executeNavigator(store, event.resolution, navigatorContext(store));
        }
      } catch { /* A changed or unavailable destination is never a reply. */ }
      if (connection === socket) send({ type: 'executed', ticket: event.ticket, ok });
      if (ok) store.toast(`${event.resolution.confirmation} · ${name}`);
    };
    socket.onclose = () => { if (!stopped) retry = setTimeout(connect, 3000); };
    socket.onerror = () => socket.close();
  }
  // Coalesce store churn; heartbeats keep background owner windows eligible.
  let queued;
  const unsubscribe = store.subscribe(() => { clearTimeout(queued); queued = setTimeout(update, 150); });
  const heartbeat = setInterval(update, 10_000);
  window.addEventListener('focus', focus); window.addEventListener('blur', blur);
  window.addEventListener('pointerdown', focus); window.addEventListener('keydown', focus);
  connect();
  return () => {
    stopped = true; clearTimeout(retry); clearTimeout(queued); clearInterval(heartbeat); unsubscribe(); socket?.close();
    window.removeEventListener('focus', focus); window.removeEventListener('blur', blur);
    window.removeEventListener('pointerdown', focus); window.removeEventListener('keydown', focus);
  };
}
