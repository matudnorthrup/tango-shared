import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { Menu } from './menu.js';

import { HOME, safePath, loadApps } from '../app-list.js';
export { createAppListCache } from '../app-list.js';
const ICONS = { desk: '▦', lift: '🏋️', food: '🥗', kilo: '💰', usage: '◫', state: '⟢', home: '⌂' };

export function appMenuItems(apps, navigate = path => window.location.assign(path)) {
  const visible = apps.filter(app => app && !app.hidden && typeof app.name === 'string' && safePath(app.path));
  const list = visible.some(app => app.path === '/') ? visible : [...visible, HOME];
  return list.map(app => ({
    key: app.id, label: app.name, on: app.id === 'desk',
    icon: safePath(app.icon)
      ? html`<img src=${app.icon} width="16" height="16" alt="" />`
      : html`<span aria-hidden="true">${ICONS[app.icon] || '◫'}</span>`,
    onSelect: () => navigate(app.path),
  }));
}

export function phoneBackCrumb(crumbs) {
  return crumbs.length > 1 ? crumbs[crumbs.length - 2] : null;
}

export function AppSwitcher({ phone = false }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState(null);
  const button = useRef(null);
  const anchor = useRef(null);
  const focus = useRef('first');
  // The dropdown closes itself on any press outside it, this button included; a press that started on an open menu
  // only closes it, rather than closing and reopening on the click that follows. Menu's own capture listener closes
  // it (and Preact re-renders) before the button's onPointerDown runs, so the press is read at the window, first.
  const pressedOpen = useRef(false);
  const openNow = useRef(false);
  openNow.current = open;
  useEffect(() => {
    const press = event => { pressedOpen.current = openNow.current && !!button.current?.contains(event.target); };
    window.addEventListener('pointerdown', press, true);
    return () => window.removeEventListener('pointerdown', press, true);
  }, []);
  const close = () => { setOpen(false); button.current?.focus({ preventScroll: true }); };
  useEffect(() => {
    if (!open) return;
    let active = true;
    loadApps().then(apps => { if (active) setItems(appMenuItems(apps)); });
    // Escape must also work while the request is pending, before Menu is mounted.
    const escape = event => { if (event.key === 'Escape') close(); };
    document.addEventListener('keydown', escape);
    return () => { active = false; document.removeEventListener('keydown', escape); };
  }, [open]);
  const show = (last = false) => {
    if (open) { close(); return; }
    const box = button.current.getBoundingClientRect();
    anchor.current = { x: box.left, y: box.bottom + 6 };
    focus.current = last ? 'last' : 'first';
    setItems(null);
    setOpen(true);
  };
  return html`<span class="nx-app-switcher">
    <button ref=${button} class=${phone ? 'nx-ib nx-app-logo' : 'nx-brand nx-app-brand'} data-menu-button aria-label="Switch Tango app" title="Switch Tango app" aria-haspopup="menu" aria-expanded=${open} aria-busy=${open && !items} onClick=${() => {
      const closing = pressedOpen.current;
      pressedOpen.current = false;
      if (closing && !open) return;
      show();
    }} onKeyDown=${event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (!open) show(event.key === 'ArrowUp'); }
    }}>
      ${phone ? html`<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 5h12M10 5v11" /></svg>` : html`Tango Desk<svg class="nx-app-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>`}
    </button>
    ${open && items ? html`<${Menu} items=${items} onClose=${close} phone=${phone} title="Tango apps" at=${phone ? null : anchor.current} focus=${focus.current} />` : null}
  </span>`;
}
