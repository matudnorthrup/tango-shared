// A prototype on the stage: its frame (stage.js draws it under the breadcrumb, clickable) and the
// sandbox it runs in. The operator drives it by voice through the navigation bridge in uploaded pages.

/** The stage's stand-in scene for a prototype: its own page in the frame, versioned so an update reloads it. */
export function prototypeStage(prototype, client) {
  return { id: `proto:${prototype.id}`, version: prototype.version, kind: 'prototype', _prototypeId: prototype.id, _url: client.prototypeUrl(prototype), _sandbox: sandboxFor(prototype) };
}

/**
 * A dev server on another origin keeps its own origin (its storage, cookies and same-origin API calls
 * work, as in its own tab). Never one on the desk's origin: that would let it reach the desk itself.
 * Uploaded bundles stay opaque (the service serves them sandboxed, with a storage shim).
 */
export function sandboxFor(prototype, here = location.origin) {
  if (!/^https?:\/\//i.test(prototype.url)) return '';
  try {
    return new URL(prototype.url).origin !== here ? 'allow-same-origin' : '';
  } catch {
    return '';
  }
}

