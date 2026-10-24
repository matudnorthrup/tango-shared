// Images the owner attaches (a reply, a new thread): reading them in, and the small UI around
// them. They travel as data URLs (server/desk/attachments.ts).
// A big image is scaled down before it goes rather than refused: a 5K screenshot
// becomes 2048 px on its long edge, which is more than any model looks at.

import { html, useRef, useState } from '../vendor/preact-htm.js';

/** What Loom (and the desk's check) take. HEIC is read in where the browser can decode it, and sent as JPEG. */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const ACCEPT = [...IMAGE_TYPES, 'image/heic', 'image/heif'].join(',');
export const MAX_IMAGES = 8;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Past either, an image is scaled down (GIFs are left alone: a canvas would keep one frame). */
const SCALE_EDGE = 2560;
const SCALE_BYTES = 4 * 1024 * 1024;
const TARGET_EDGE = 2048;

const readDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsDataURL(blob);
  });

const bytesOf = (dataUrl) => {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  return Math.floor((base64.length * 3) / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
};

const isHeic = (file) => /^image\/hei[cf]$/.test(file.type) || (!file.type && /\.hei[cf]$/i.test(file.name || ''));

/** A pasted screenshot has no name ("image.png" at best); give it one the agent can tell apart. */
function nameFor(file, mimeType) {
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[mimeType];
  const base = (file.name && file.name !== 'image.png' ? file.name : `screenshot-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`).replace(/\.[a-z0-9]+$/i, '');
  return `${base}.${ext}`;
}

/** Scales a decodable image to TARGET_EDGE on its long side: PNG stays PNG while that stays small, else JPEG. */
async function scaled(file, mimeType) {
  const bitmap = await createImageBitmap(file);
  const ratio = Math.min(1, TARGET_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
  canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  if (mimeType === 'image/png') {
    const png = canvas.toDataURL('image/png');
    if (bytesOf(png) <= SCALE_BYTES) return { mimeType, dataUrl: png };
  }
  return { mimeType: 'image/jpeg', dataUrl: canvas.toDataURL('image/jpeg', 0.88) };
}

async function needsScaling(file) {
  if (file.size > SCALE_BYTES) return true;
  try {
    const bitmap = await createImageBitmap(file);
    const big = Math.max(bitmap.width, bitmap.height) > SCALE_EDGE;
    bitmap.close?.();
    return big;
  } catch {
    return false;
  }
}

/**
 * One file → `{ id, name, mimeType, dataUrl, sizeBytes }`, or `{ error }` saying why it can't go.
 * Never throws.
 */
export async function prepareImage(file) {
  const heic = isHeic(file);
  if (!heic && !IMAGE_TYPES.includes(file.type)) return { error: `“${file.name || 'that file'}” isn’t an image (PNG, JPEG, GIF or WebP).` };
  try {
    let mimeType = file.type;
    let dataUrl;
    if (heic) ({ mimeType, dataUrl } = await scaled(file, 'image/jpeg'));
    else if (file.type !== 'image/gif' && (await needsScaling(file))) ({ mimeType, dataUrl } = await scaled(file, file.type));
    else dataUrl = await readDataUrl(file);
    const sizeBytes = bytesOf(dataUrl);
    if (sizeBytes > MAX_IMAGE_BYTES) return { error: `“${file.name || 'that image'}” is over 10 MB.` };
    return { id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`, name: nameFor(file, mimeType), mimeType, dataUrl, sizeBytes };
  } catch {
    return { error: heic ? `This browser can’t read “${file.name}” (HEIC); share it as a JPEG.` : `Couldn’t read “${file.name || 'that image'}”.` };
  }
}

/** The image files in a paste (none when it's only text, so the paste goes through as usual). */
export function pastedFiles(event) {
  return [...(event.clipboardData?.items || [])].filter((i) => i.kind === 'file' && /^image\//.test(i.type)).map((i) => i.getAsFile()).filter(Boolean);
}

/** True while a drag carries files (not text or a link being dragged around the page). */
export function dragHasFiles(event) {
  return [...(event.dataTransfer?.types || [])].includes('Files');
}

/**
 * Files dragged over an element (spread `handlers` on it): `over` while they're above it, for the drop
 * hint, and `onFiles` with what's dropped. A drop is always caught, so a missed target never navigates
 * the page away. `blocked` refuses drops (no hint, a no-entry cursor).
 */
export function useFileDrop(onFiles, { blocked = false } = {}) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const handlers = {
    onDragEnter: (e) => {
      if (!dragHasFiles(e)) return;
      e.preventDefault();
      depth.current += 1;
      if (!blocked) setOver(true);
    },
    onDragOver: (e) => {
      if (!dragHasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = blocked ? 'none' : 'copy';
    },
    onDragLeave: (e) => {
      if (!dragHasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setOver(false);
    },
    onDrop: (e) => {
      if (!dragHasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setOver(false);
      if (!blocked) onFiles([...e.dataTransfer.files]);
    },
  };
  return { over, handlers };
}

/** Over whatever files are dragged onto: where they go. `inside` keeps it to its (positioned) parent. */
export function DropHint({ text, inside = false }) {
  return html`<div class=${`att-drop${inside ? ' inside' : ''}`} aria-hidden="true"><span>${text}</span></div>`;
}

/** The thumbnails pinned in a draft: tap to look closer, ✕ to take one out. `reading` adds placeholders. */
export function Shelf({ images, reading = 0, onRemove, onOpen }) {
  if (!images.length && !reading) return null;
  return html`<div class="att-shelf">
    ${images.map(
      (a, i) => html`<span class="att-tile" key=${a.id || i}>
        <button class="att-img" title=${a.name} aria-label=${`Look at ${a.name}`} onClick=${() => onOpen?.(i)}><img src=${a.dataUrl || a.url} alt="" /></button>
        <button class="att-x" aria-label=${`Remove ${a.name}`} title="Remove" onClick=${() => onRemove(a.id ?? i)}>✕</button>
      </span>`,
    )}
    ${Array.from({ length: reading }, (_, i) => html`<span class="att-tile reading" key=${`r${i}`} aria-label="Adding an image…"></span>`)}
  </div>`;
}

/** Images on a message in the transcript: a row of tiles; tapping one opens them full size. */
export function Thumbs({ images, store }) {
  if (!images?.length) return null;
  const list = images.map((a) => ({ src: a.url, name: a.name }));
  return html`<div class="att-thumbs">
    ${images.map((a, i) => html`<button class="att-thumb" title=${a.name} aria-label=${`Look at ${a.name}`} onClick=${() => store.openLightbox(list, i)}><img src=${a.url} alt=${a.name} loading="lazy" /></button>`)}
  </div>`;
}

/** Full size, one at a time: ← → step, Esc or a tap outside closes (the keys are main.js onKey's). */
export function Lightbox({ store }) {
  const box = store.state.lightbox;
  if (!box) return null;
  const { images, index } = box;
  const image = images[index];
  if (!image) return null;
  const step = (dir) => store.set({ lightbox: { images, index: (index + dir + images.length) % images.length } });
  return html`<div
    class="att-lightbox"
    role="dialog"
    aria-modal="true"
    aria-label=${image.name}
    onClick=${(e) => e.target === e.currentTarget && store.set({ lightbox: null })}
  >
    <img src=${image.src} alt=${image.name} />
    <div class="att-lb-bar">
      ${images.length > 1 ? html`<button class="btn" onClick=${() => step(-1)}>←</button>` : null}
      <span class="note">${image.name}${images.length > 1 ? ` · ${index + 1} of ${images.length}` : ''}</span>
      ${images.length > 1 ? html`<button class="btn" onClick=${() => step(1)}>→</button>` : null}
      <button class="btn" onClick=${() => store.set({ lightbox: null })}>Close <span class="kbd">esc</span></button>
    </div>
  </div>`;
}
