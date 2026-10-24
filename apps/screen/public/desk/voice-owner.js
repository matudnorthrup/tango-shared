// Both browser voice entry points share one owner in this window.
let current = null;
export function claimVoice(session) { current?.cancel(); current = session; }
export function releaseVoice(session) { if (current === session) current = null; }
