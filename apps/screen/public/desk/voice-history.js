// Per browser/device only; never put this preference or transcripts in shared desk settings.
const KEY = 'desk.dictationHistory';
export function historyEnabled() {
  try { return localStorage.getItem(KEY) !== 'off'; } catch { return false; }
}
export function setHistoryEnabled(on) {
  localStorage.setItem(KEY, on ? 'on' : 'off');
}
export function applyHistoryPreference(url, role) {
  const page = new URL(location.href);
  if (!historyEnabled()) url.searchParams.set('history', 'off');
  if (role === 'screen' || page.searchParams.get('role') === 'screen') url.searchParams.set('role', 'screen');
  if (page.searchParams.get('detached') === '1') url.searchParams.set('detached', '1');
  if (window.top !== window.self) url.searchParams.set('framed', '1');
}
