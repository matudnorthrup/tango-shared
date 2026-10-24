// The navigation bridge: injected into every HTML page of an uploaded bundle, so
// a prototype shown in the desk's Prototype view can be driven by voice. It does
// nothing unless the page is framed (opened in its own tab, it's inert).
//
// Parent → page: { type: 'command', name, args }
//   scroll_down / scroll_up / scroll_top / scroll_bottom
//   click   { target }          the clickable whose label matches (exact, then contains)
//   go_to   { target }          scroll a heading (or any clickable) into view
//   fill    { target, text }    type into a field (matched by label, placeholder, or name)
//   back / forward / reload     the frame's own history
// Page → parent: { type: 'proto-page', page } on load and whenever what's on the
// page changes: its address, title, the clickables (in-view first), headings,
// fields, and how far down it's scrolled. { type: 'proto-result', name, ok, detail }
// after each command, so the operator can say when a click found nothing.
//
// Kept as a plain JS string (no build step, and the service runs under tsx,
// which would rewrite named functions in page code).

export const PROTOTYPE_BRIDGE = `<script>(function () {
  if (window.parent === window || window.__tangoProto) return;
  window.__tangoProto = true;
  var MAX_TARGETS = 40, MAX_HEADINGS = 20, MAX_FIELDS = 12, MAX_LABEL = 60;
  var CLICKABLE = 'a[href], button, [role=button], [role=tab], [role=link], [role=menuitem], [role=option], [role=switch], [role=checkbox], [role=radio], summary, input[type=submit], input[type=button], input[type=reset], input[type=checkbox], input[type=radio], [onclick], [data-choice]';
  var FIELD = 'input:not([type]), input[type=text], input[type=search], input[type=email], input[type=number], input[type=tel], input[type=url], input[type=password], input[type=date], input[type=time], input[type=month], input[type=week], input[type=datetime-local], textarea, select, [contenteditable=true]';
  function clip(text) { text = String(text || '').replace(/\\s+/g, ' ').trim(); return text.length > MAX_LABEL ? text.slice(0, MAX_LABEL - 1) + '…' : text; }
  function visible(el) {
    if (!el.getClientRects().length) return false;
    var style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05;
  }
  function inView(el) { var r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth; }
  function labelOf(el) {
    var aria = el.getAttribute('aria-label');
    if (aria) return clip(aria);
    if (el.labels && el.labels.length) return clip(el.labels[0].innerText);
    // A field's value is what was typed (an email, a password): never a label. Only a button input's value is.
    var buttonValue = el.tagName === 'INPUT' && /^(submit|button|reset)$/i.test(el.type) ? el.value : '';
    var text = el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' ? '' : el.innerText || buttonValue || '';
    if (!String(text).trim()) {
      var img = el.querySelector && el.querySelector('img[alt], svg title');
      text = el.getAttribute('title') || (img && (img.getAttribute('alt') || img.textContent)) || el.getAttribute('placeholder') || el.getAttribute('name') || '';
    }
    return clip(text);
  }
  function kindOf(el) {
    var role = el.getAttribute('role');
    if (role) return role === 'button' ? 'button' : role;
    var tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'input') return el.type === 'checkbox' || el.type === 'radio' ? el.type : 'button';
    return tag === 'summary' ? 'toggle' : 'button';
  }
  function candidates(selector) {
    var seen = [];
    Array.prototype.forEach.call(document.querySelectorAll(selector), function (el) {
      if (el.disabled || el.getAttribute('aria-disabled') === 'true' || !visible(el)) return;
      // A clickable inside another clickable (an icon in a button) is the same target.
      if (el.parentElement && el.parentElement.closest(selector)) return;
      seen.push(el);
    });
    // What the owner can see first, then the rest in page order.
    return seen.filter(inView).concat(seen.filter(function (el) { return !inView(el); }));
  }
  function scroller() {
    var root = document.scrollingElement || document.documentElement;
    if (root.scrollHeight > root.clientHeight + 2) return root;
    var best = null;
    Array.prototype.forEach.call([document.body].concat(Array.prototype.slice.call(document.querySelectorAll('body *'))), function (el) {
      if (!el) return;
      var style = getComputedStyle(el);
      if (!/(auto|scroll)/.test(style.overflowY) || el.scrollHeight <= el.clientHeight + 2) return;
      if (!best || el.clientHeight * el.clientWidth > best.clientHeight * best.clientWidth) best = el;
    });
    return best || root;
  }
  function snapshot() {
    var targets = [], labels = {};
    candidates(CLICKABLE).forEach(function (el) {
      if (targets.length >= MAX_TARGETS) return;
      var label = labelOf(el);
      if (!label || labels[label.toLowerCase()]) return;
      labels[label.toLowerCase()] = true;
      targets.push({ label: label, kind: kindOf(el), inView: inView(el) });
    });
    var headings = [];
    Array.prototype.forEach.call(document.querySelectorAll('h1, h2, h3'), function (el) {
      if (headings.length < MAX_HEADINGS && visible(el)) { var text = clip(el.innerText); if (text) headings.push(text); }
    });
    var fields = [];
    candidates(FIELD).forEach(function (el) {
      if (fields.length < MAX_FIELDS) { var label = labelOf(el); if (label) fields.push(label); }
    });
    var box = scroller();
    var max = Math.max(0, box.scrollHeight - box.clientHeight);
    return {
      path: location.pathname.replace(/^.*?\\/bundles\\/[a-f0-9]+\\//, '') + location.hash,
      title: clip(document.title),
      targets: targets,
      headings: headings,
      fields: fields,
      scroll: { percent: max ? Math.round((box.scrollTop / max) * 100) : 0, scrollable: max > 0 }
    };
  }
  function post(message) { try { parent.postMessage(message, '*'); } catch (_) {} }
  var last = '', timer = null, forced = false;
  function report(force) {
    // A forced report (after a command) survives the change-driven ones that follow it.
    forced = forced || !!force;
    clearTimeout(timer);
    timer = setTimeout(function () {
      var page = snapshot(), key = JSON.stringify(page);
      var always = forced;
      forced = false;
      if (!always && key === last) return;
      last = key;
      post({ type: 'proto-page', page: page });
    }, force ? 0 : 350);
  }
  function norm(text) { return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  function find(selector, wanted, extra) {
    var want = norm(wanted);
    if (!want) return null;
    var pool = candidates(selector);
    var label = function (el) { return norm(labelOf(el) + ' ' + (extra ? extra(el) : '')); };
    return pool.find(function (el) { return norm(labelOf(el)) === want; })
      || pool.find(function (el) { return label(el).indexOf(want) >= 0; })
      || pool.find(function (el) { var have = norm(labelOf(el)); return have && want.indexOf(have) >= 0; })
      || null;
  }
  function flash(el) {
    var before = el.style.outline, offset = el.style.outlineOffset;
    el.style.outline = '3px solid #4c8dff';
    el.style.outlineOffset = '2px';
    setTimeout(function () { el.style.outline = before; el.style.outlineOffset = offset; }, 900);
  }
  function scrollBy(name) {
    var el = scroller();
    var page = Math.max(120, el.clientHeight * 0.8);
    var top = name === 'scroll_top' ? 0 : name === 'scroll_bottom' ? el.scrollHeight : el.scrollTop + (name === 'scroll_up' ? -page : page);
    el.scrollTo({ top: top, behavior: 'smooth' });
  }
  function run(name, args) {
    args = args || {};
    if (/^scroll_(down|up|top|bottom)$/.test(name)) { scrollBy(name); return { ok: true }; }
    if (name === 'back') { history.back(); return { ok: true }; }
    if (name === 'forward') { history.forward(); return { ok: true }; }
    if (name === 'reload') { location.reload(); return { ok: true }; }
    if (name === 'click') {
      var el = find(CLICKABLE, args.target);
      if (!el) return { ok: false, detail: 'nothing called "' + clip(args.target) + '" on the page' };
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      flash(el);
      el.click();
      return { ok: true, detail: labelOf(el) };
    }
    if (name === 'go_to') {
      var want = norm(args.target);
      var heading = want && (Array.prototype.find.call(document.querySelectorAll('h1, h2, h3, h4, h5, legend, [role=heading]'), function (h) { return visible(h) && norm(h.innerText).indexOf(want) >= 0; })
        || Array.prototype.find.call(document.querySelectorAll('[id]'), function (h) { return visible(h) && norm(h.id) === want; })
        || find(CLICKABLE, args.target));
      if (!heading) return { ok: false, detail: 'no "' + clip(args.target) + '" on the page' };
      heading.scrollIntoView({ block: 'start', behavior: 'smooth' });
      flash(heading);
      return { ok: true, detail: clip(heading.innerText) };
    }
    if (name === 'fill') {
      var field = find(FIELD, args.target, function (f) { return (f.getAttribute('placeholder') || '') + ' ' + (f.getAttribute('name') || ''); });
      if (!field) return { ok: false, detail: 'no field called "' + clip(args.target) + '"' };
      field.scrollIntoView({ block: 'center', behavior: 'smooth' });
      field.focus();
      if (field.tagName === 'SELECT') {
        // A select takes one of its options, by the label shown (or its value), never free text.
        var wanted = norm(args.text);
        var options = Array.prototype.slice.call(field.options);
        // Dictation spells ranges and numbers its own way ("2 to 10" for "2–10"): the digits decide then.
        var digits = function (t) { return String(t || '').replace(/[^0-9]+/g, ' ').trim(); };
        var option = options.find(function (o) { return norm(o.label || o.text) === wanted || norm(o.value) === wanted; })
          || options.find(function (o) { return wanted && norm(o.label || o.text).indexOf(wanted) >= 0; })
          || (function () {
            // Only when the digits pick out exactly one option ("2–10 monthly" and "2–10 yearly" need words).
            var same = options.filter(function (o) { return digits(args.text) && digits(o.label || o.text) === digits(args.text); });
            return same.length === 1 ? same[0] : null;
          })();
        // Never echo what was asked for: it may be private, and results are traced.
        if (!option) return { ok: false, detail: 'no matching option in ' + labelOf(field) + ' (options: ' + options.map(function (o) { return clip(o.label || o.text); }).slice(0, 8).join(', ') + ')' };
        field.value = option.value;
      } else if (field.isContentEditable) field.textContent = String(args.text || '');
      else {
        var proto = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        var setter = Object.getOwnPropertyDescriptor(proto, 'value');
        // The native setter, so frameworks that track the value (React) see the change.
        var before = field.value;
        if (setter && setter.set) setter.set.call(field, String(args.text || '')); else field.value = String(args.text || '');
        // A constrained input (a number, a date) drops text it can't take: put it back and say so.
        if (String(args.text || '') && !field.value) {
          if (setter && setter.set) setter.set.call(field, before); else field.value = before;
          return { ok: false, detail: labelOf(field) + ' (a ' + (field.type || 'text') + ' field) did not take that' };
        }
      }
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
      flash(field);
      return { ok: true, detail: labelOf(field) };
    }
    return { ok: false, detail: 'unknown command ' + name };
  }
  window.addEventListener('message', function (event) {
    if (event.source !== parent) return;
    var message = event.data || {};
    if (message.type !== 'command' || typeof message.name !== 'string') return;
    var result;
    try { result = run(message.name, message.args); } catch (err) { result = { ok: false, detail: String(err && err.message || err) }; }
    post({ type: 'proto-result', name: message.name, commandId: typeof message.commandId === 'string' ? message.commandId : null, ok: !!result.ok, detail: result.detail || '' });
    report(true);
    setTimeout(function () { report(false); }, 700);
  });
  function start() {
    report(true);
    try { new MutationObserver(function () { report(false); }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true }); } catch (_) {}
  }
  addEventListener('scroll', function () { report(false); }, true);
  // Clicking and typing count as use even when the page doesn't change (the desk's idle return).
  var lastActivity = 0;
  function activity(event) {
    if (!event.isTrusted) return; // the bridge's own fill events are the operator's, not the owner's
    var now = Date.now();
    if (now - lastActivity < 20000) return;
    lastActivity = now;
    post({ type: 'proto-activity' });
  }
  ['pointerdown', 'keydown', 'input', 'wheel', 'touchstart'].forEach(function (type) { addEventListener(type, activity, { capture: true, passive: true }); });
  // Escape the page didn't use for itself goes to the desk: focus in a frame keeps keys from reaching it.
  // Decided once the event has been through every handler, the page's own included (they may be added later),
  // and never when the browser itself takes it (a modal <dialog>, a popover, full screen) without saying so.
  function nativeEscape() { if (document.fullscreenElement) return true; try { return !!document.querySelector(':modal, :popover-open:not([popover="manual"])'); } catch (_) { return false; } }
  addEventListener('keydown', function (event) { if (event.key !== 'Escape' || nativeEscape()) return; setTimeout(function () { if (!event.defaultPrevented) post({ type: 'proto-key', key: 'Escape' }); }, 0); });
  addEventListener('hashchange', function () { report(true); });
  addEventListener('popstate', function () { report(true); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  addEventListener('load', function () { report(false); });
})();</script>`;

/**
 * Appends the bridge at the very end of the document. Matching a `</body>` in the text can land
 * inside a script, a template or a comment; after the end, the HTML parser always puts a script back
 * into the body. It waits for the DOM itself.
 */
export function withPrototypeBridge(html: string): string {
  return html + PROTOTYPE_BRIDGE;
}
