// The next layout's touch gestures on a phone (a bigger touch screen gets only the pull):
// - Pull down past the top of a list and let go: the switcher opens with the keyboard up. The page
//   follows the finger (no re-render per frame), and the notch clicks once when crossed.
// - Drag in from the left edge: on a pushed page (a thread, a project, an agent) the page follows the
//   finger and, let go past a third of the width or flicked, goes back; on a top page it opens the drawer.
// Drags that start in an overlay (a sheet, a menu, the switcher) or a field are left alone.

import { html, useEffect, useRef } from '../../vendor/preact-htm.js';
import { SEARCH_ICON } from '../search.js';
import { focusSwitcher } from './switcher.js';

const NOTCH = 64; // px of pull (after resistance) that arms it
const MAX = 96;
const resist = (dy) => Math.min(MAX, dy * 0.5);
const EDGE = 24; // px from the left edge where a back swipe starts

function inOverlay(node) {
  for (let el = node; el && el !== document.body; el = el.parentElement) {
    if (el.getAttribute?.('role') === 'dialog' || getComputedStyle(el).position === 'fixed') return true;
  }
  return false;
}

/** Attach on a touch screen. `pull` when the page is a list; `onBack` on a pushed page (else no edge swipe). */
export function useGestures({ enabled, pull, onPull, onBack }) {
  const cue = useRef(null);
  const body = useRef(null);
  const handlers = useRef({});
  handlers.current = { pull, onPull, onBack };
  useEffect(() => {
    if (!enabled) return undefined;
    let start = null; // { x, y, t, mode: null | 'pull' | 'back' }
    let armed = false;
    let lastX = 0;
    let lastT = 0;
    let vx = 0;
    const width = () => window.innerWidth || 390;
    const paintPull = (px, animate) => {
      const ease = animate ? 'transform .22s ease' : 'none';
      if (body.current) Object.assign(body.current.style, { transform: px ? `translateY(${px}px)` : '', transition: ease });
      if (cue.current) {
        Object.assign(cue.current.style, { opacity: String(Math.min(1, px / NOTCH)), transform: `translateY(${px - MAX}px)`, transition: animate ? 'transform .22s ease, opacity .22s ease' : 'none' });
        cue.current.classList.toggle('armed', armed);
      }
    };
    const paintBack = (px, animate) => {
      if (!body.current) return;
      Object.assign(body.current.style, { transform: px ? `translateX(${px}px)` : '', transition: animate ? 'transform .22s ease' : 'none', boxShadow: px ? '-12px 0 30px rgba(0,0,0,.35)' : '' });
    };
    const onStart = (e) => {
      if (e.touches.length !== 1 || e.target.closest('input, textarea, select, .nx-sheet') || inOverlay(e.target)) return;
      const t = e.touches[0];
      start = { x: t.clientX, y: t.clientY, mode: null, edge: t.clientX <= EDGE, top: window.scrollY <= 0 };
      armed = false;
      lastX = t.clientX;
      lastT = e.timeStamp;
      vx = 0;
    };
    const onMove = (e) => {
      if (!start) return;
      const t = e.touches[0];
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      if (!start.mode) {
        if (start.edge && handlers.current.onBack && dx > 8 && Math.abs(dx) > Math.abs(dy)) start.mode = 'back';
        else if (start.top && handlers.current.pull && dy > 6 && dy > Math.abs(dx)) start.mode = 'pull';
        else if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
          start = null;
          return;
        } else return;
      }
      e.preventDefault();
      if (start.mode === 'pull') {
        const px = resist(Math.max(0, dy));
        const now = px >= NOTCH;
        if (now !== armed) {
          armed = now;
          if (armed) navigator.vibrate?.(8);
        }
        paintPull(px, false);
      } else {
        const dt = Math.max(1, e.timeStamp - lastT);
        vx = (t.clientX - lastX) / dt;
        lastX = t.clientX;
        lastT = e.timeStamp;
        paintBack(Math.max(0, dx), false);
      }
    };
    const onEnd = () => {
      if (!start) return;
      const s = start;
      start = null;
      if (s.mode === 'pull') {
        const go = armed;
        if (go) focusSwitcher(); // inside the touch, so iOS raises the keyboard
        armed = false;
        paintPull(0, true);
        if (go) handlers.current.onPull?.();
      } else if (s.mode === 'back') {
        const dx = lastX - s.x;
        const go = dx > width() * 0.35 || (vx > 0.45 && dx > 30);
        if (go) {
          paintBack(width(), true);
          setTimeout(() => (paintBack(0, false), handlers.current.onBack?.()), 180);
        } else paintBack(0, true);
      }
    };
    const cancel = () => {
      start = null;
      armed = false;
      paintPull(0, true);
      paintBack(0, true);
    };
    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);
    document.addEventListener('touchcancel', cancel);
    document.documentElement.classList.add('nx-gestures');
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', cancel);
      document.documentElement.classList.remove('nx-gestures');
    };
  }, [enabled]);
  return { cue, body };
}

export function PullCue({ cueRef }) {
  return html`<div class="nx-pull" ref=${cueRef} aria-hidden="true"><span class="nx-pull-dot">${SEARCH_ICON}</span><span class="nx-pull-t"><span class="a">Pull to search</span><span class="b">Let go to search</span></span></div>`;
}
