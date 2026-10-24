import { html } from '../vendor/preact-htm.js';
import { storageGet, storageSet } from './util.js';

export function readReceipts() {
  try {
    return JSON.parse(storageGet('ownerReceipts', '[]')).filter(r => r && typeof r.commandId === 'string' && typeof r.text === 'string')
      .map(r => r.status === 'sending' ? { ...r, status: 'uncertain' } : r);
  } catch { return []; }
}
export function saveReceipts(receipts) { storageSet('ownerReceipts', JSON.stringify(receipts)); }

/** A server echo wins by identity, even if the HTTP answer was lost or is still pending. */
export function mergeOwnerReceipts(itemId, detail, local = []) {
  const source = detail?.ownerReceipts || [];
  const confirmed = new Set([...(detail?.receiptCommandIds || []), ...source.map(r => r.commandId).filter(Boolean)]);
  return [...source, ...local.filter(r => r.itemId === itemId && !confirmed.has(r.commandId))]
    .sort((a, b) => a.at - b.at);
}
const LABEL = { sending: 'Sending', delivered: 'Delivered', queued: 'Queued', 'picked-up': 'Agent picked it up', failed: 'Not delivered', uncertain: 'Delivery unconfirmed' };
export function OwnerReceipts({ item, d, store, onlyMessageId = null }) {
  const receipts = mergeOwnerReceipts(item.id, d, store.state.ownerReceipts)
    .filter(r => onlyMessageId ? r.messageId === onlyMessageId : !d?.sinceOwner || r.messageId !== d.sinceOwner.owner.messageId);
  if (!receipts.length) return null;
  return html`<section class="rd-owner-receipts" aria-label="Your messages">
    ${receipts.map(r => html`<article key=${r.commandId || r.messageId} class="rd-owner-receipt">
      <b>You</b><p style="white-space:pre-wrap;overflow-wrap:anywhere">${r.text}</p>
      <small role="status">${LABEL[r.status]}</small>
      ${r.status === 'failed' || r.status === 'uncertain' ? html`<span> · <button class="linkish" onClick=${() => r.images ? store.openReply(item.id) : store.retryReceipt(r)}>${r.images ? 'Review draft' : 'Retry'}</button></span>` : null}
    </article>`)}
  </section>`;
}
