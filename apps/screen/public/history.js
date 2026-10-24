// A private top-level view: no hub, shared routes, telemetry, persistent browser cache, or transcript URLs.
const $ = id => document.getElementById(id);
let snapshot = null;
let requestId = 0;
let controller;
let busy = false;
const endpoint = new URL('api/desk/dictation-history', location.href);
function forget() { snapshot = null; $('entries').replaceChildren(); }
async function api(body) {
  const response = await fetch(endpoint, { method: body ? 'POST' : 'GET', cache: 'no-store', signal: controller?.signal,
    headers: { 'X-History-Client': 'desk', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error === 'generation_changed' ? 'History changed on another device. Refresh and try again.' : 'History unavailable. Refresh to retry.');
  return data;
}
function render() {
  const q = $('search').value.toLocaleLowerCase();
  $('entries').replaceChildren();
  if (!snapshot) return;
  const entries = snapshot.entries.filter(e => `${e.text} ${e.destination}`.toLocaleLowerCase().includes(q));
  for (const e of entries) {
    const card = document.createElement('article');
    const meta = document.createElement('small');
    meta.textContent = `${new Date(e.capturedAt).toLocaleString()} · Device ${e.device.slice(0, 8)} · ${e.outcome}${e.destination ? ` · ${e.destination}` : ''}`;
    const text = document.createElement('p'); text.textContent = e.text;
    const copy = document.createElement('button'); copy.textContent = 'Copy';
    copy.onclick = async () => { try { await navigator.clipboard.writeText(e.text); $('status').textContent = 'Copied.'; } catch { $('status').textContent = 'Copy unavailable. Select the text to copy it.'; } };
    const remove = document.createElement('button'); remove.textContent = 'Delete';
    remove.onclick = () => mutate({ action: 'delete', id: e.id });
    card.append(meta, text, copy, remove); $('entries').append(card);
  }
  if (!entries.length) $('entries').textContent = q ? 'No matching dictations.' : 'No synced dictations yet.';
}
async function refresh() {
  if (busy) return;
  const id = ++requestId;
  controller?.abort(); controller = new AbortController();
  forget(); $('status').textContent = 'Loading…';
  try {
    const data = await api();
    if (id !== requestId || document.hidden) return;
    snapshot = data; render(); $('status').textContent = `Updated ${new Date().toLocaleTimeString()}.`;
  } catch { if (id === requestId) { forget(); $('status').textContent = 'History unavailable. Refresh to retry.'; } }
}
async function mutate(change) {
  if (!snapshot || busy) return;
  const generation = snapshot.generation;
  busy = true; requestId++; controller?.abort(); controller = new AbortController();
  $('clear').disabled = true; $('refresh').disabled = true;
  forget();
  try {
    await api({ ...change, generation });
    if (change.action === 'clear') $('search').value = '';
    busy = false; if (!document.hidden) await refresh();
  }
  catch (e) { forget(); $('status').textContent = e.message; }
  finally { busy = false; $('clear').disabled = false; $('refresh').disabled = false; }
}
$('search').oninput = render;
$('refresh').onclick = refresh;
$('clear').onclick = () => $('confirm').showModal();
$('cancel').onclick = () => $('confirm').close();
$('confirm-clear').onclick = () => { $('confirm').close(); return mutate({ action: 'clear' }); };
function hide() { requestId++; controller?.abort(); forget(); $('search').value = ''; $('confirm').close(); }
window.addEventListener('pagehide', hide);
document.addEventListener('visibilitychange', () => document.hidden ? hide() : refresh());
window.addEventListener('pageshow', refresh);
// Refresh removes remote deletions and expires text without leaving an idle page holding it indefinitely.
setInterval(() => { if (!document.hidden) refresh(); }, 60_000);
if (window.top !== window.self || location.search) { forget(); document.body.textContent = 'Open history from your owner desk.'; }
else refresh();
