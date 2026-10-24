// The scene stage: two sandboxed iframes that crossfade, kept outside Preact so
// a re-render never reloads a frame. Ported from the old shell.js.
//
// Safari rules this keeps:
//  - frames are display:none unless a scene is loading or up (.live); a faded-out
//    frame is retired (src removed) instead of left over the list invisible;
//  - a frame that isn't up is inert and gives focus back: a click inside a prototype
//    otherwise keeps focus in the hidden frame after the view changes, and dictation
//    tools (Wispr Flow) that read the focused element see no text field and drop the paste;
//  - the document scrolls, never a nested box; nothing sets overflow:hidden on
//    html/body. While a scene is up the views render nothing scrollable.

export function createStage({ client, onToast, onLoaded, onPrototype, onEscape }) {
  const frames = [document.getElementById('frame-a'), document.getElementById('frame-b')];
  // The frames' own sandbox; a scene may widen it for its load (a dev-server prototype keeps its origin).
  const baseSandbox = frames[0].getAttribute('sandbox') || '';
  const updatedPill = document.getElementById('updated');
  let active = 0;
  let showing = null;
  let pending = []; // commands for a scene whose frame is still loading
  let pillTimer = null;

  // A prototype (Prototype view) rides the same frames: its own page, no scene document around it.
  const urlFor = (scene) => scene._url || client.frameUrl(scene);

  // Off screen: focus can't stay in it or land in it. (WebKit ignores blur() on a focused frame.)
  function hide(frame) {
    frame.classList.remove('on');
    frame.inert = true;
    if (document.activeElement === frame) window.focus();
  }
  frames.forEach((f) => (f.inert = !f.classList.contains('on')));

  function retire(frame) {
    if (frame.classList.contains('on')) return;
    frame.removeAttribute('src');
    frame.classList.remove('live');
  }

  function flashUpdated() {
    updatedPill.classList.add('on');
    clearTimeout(pillTimer);
    pillTimer = setTimeout(() => updatedPill.classList.remove('on'), 1800);
  }

  function show(scene, { updated = false } = {}) {
    const previous = showing;
    showing = scene || null;
    if (!scene || !previous || previous.id !== scene.id || previous.version !== scene.version) pending = [];
    if (!scene) {
      frames.forEach(hide);
      document.documentElement.classList.remove('scene-on');
      setTimeout(() => {
        if (!showing) frames.forEach(retire);
      }, 600);
      return;
    }
    const sameScene = previous && previous.id === scene.id;
    if (sameScene && previous.version === scene.version && frames[active].classList.contains('on')) return;
    const next = 1 - active;
    const incoming = frames[next];
    const outgoing = frames[active];
    incoming.onload = () => {
      incoming.onload = null;
      if (showing !== scene) return;
      incoming.classList.add('on');
      incoming.inert = false;
      hide(outgoing);
      document.documentElement.classList.add('scene-on');
      active = next;
      flush(); // the bridge ran before onload; deliver in order, ahead of anything newer
      if (updated || sameScene) flashUpdated();
      onLoaded?.(scene);
      setTimeout(() => {
        if (frames[1 - active] === outgoing) retire(outgoing);
      }, 600);
    };
    incoming.classList.add('live');
    // Takes effect with this navigation: set it before src.
    incoming.setAttribute('sandbox', scene._sandbox ? `${baseSandbox} ${scene._sandbox}` : baseSandbox);
    incoming.src = urlFor(scene);
  }

  function post(message) {
    const frame = frames[active];
    if (!showing) return false;
    if (!frame.classList.contains('on') || frame.getAttribute('src') !== urlFor(showing)) {
      pending.push({ url: urlFor(showing), message }); // bound to this exact version
      return true;
    }
    frame.contentWindow?.postMessage(message, '*');
    return true;
  }

  function flush() {
    const queued = pending;
    pending = [];
    for (const entry of queued) if (showing && entry.url === urlFor(showing)) post(entry.message);
  }

  // Input from a scene: only from our own frames.
  window.addEventListener('message', (event) => {
    if (!frames.some((f) => f.contentWindow === event.source)) return;
    const message = event.data || {};
    if (message.type === 'input' && message.input) {
      client
        .input({ sceneId: message.sceneId, type: message.input.type, data: message.input.data || {} })
        .catch(() => onToast?.('That did not go through'));
    } else if ((message.type === 'proto-page' || message.type === 'proto-result' || message.type === 'proto-activity') && showing?._prototypeId) {
      // The navigation bridge in the prototype on screen: what's on the page, and how a command went.
      // Only the frame holding it (it may still be loading in): never one fading out with the last page.
      if (frames.some((f) => f.contentWindow === event.source && f.getAttribute('src') === urlFor(showing))) onPrototype?.(showing._prototypeId, message);
    } else if ((message.type === 'key' || message.type === 'proto-key') && message.key === 'Escape') {
      // Escape pressed inside the scene or prototype on screen (its frame has the focus).
      if (frames.some((f) => f.contentWindow === event.source && f.classList.contains('on'))) onEscape?.();
    } else if (message.type === 'error') {
      console.warn(`[scene ${message.sceneId}]`, message.message);
    }
  });

  return {
    show,
    post,
    get showing() {
      return showing;
    },
  };
}

/**
 * "Scroll down" by voice with no scene up: the document itself scrolls, or the beat / sheet open
 * over the Conversation view when there is one. The reply box docked at the bottom covers part of
 * the page, so a page is a little less than the window.
 */
export function scrollDocument(name) {
  const box = document.querySelector('.rd-mbody');
  const height = box ? box.clientHeight : window.innerHeight;
  const page = Math.max(120, height * (box ? 0.85 : 0.6));
  const now = box ? box.scrollTop : window.scrollY;
  const end = box ? box.scrollHeight : document.documentElement.scrollHeight;
  const top =
    name === 'scroll_top' ? 0
    : name === 'scroll_bottom' ? end
    : name === 'scroll_up' ? now - page
    : name === 'scroll_down' ? now + page
    : null;
  if (top === null) return;
  if (box) box.scrollTo({ top, behavior: 'smooth' });
  else window.scrollTo({ top, behavior: 'smooth' });
}
