import { html, render } from '../vendor/preact-htm.js';
import { AskCard } from './ask-card.js';
import { createStore } from './store.js';
import { Needs } from './conversation.js';
import { ChapterBrief } from './next/chapter.js';
const records = [
  { id: 'A-901', kind: 'do', status: 'open', text: 'Connect the backup drive and unlock it.', class: 'credentials-identity', due: '2030-01-02T12:00:00Z', revision: 1, steps: [{ text: 'Connect the drive' }, { text: 'Unlock the drive' }] },
  { id: 'A-902', kind: 'answer', status: 'open', text: 'Which drive holds the backup?', revision: 1 },
  { id: 'A-903', kind: 'unclear', status: 'open', text: 'Tell me where you left the drive.', legacy: true, revision: 1 },
];
window.askFixture = { calls: [], records, fail: false };
// The real store classifies an authoritative command failure for the card's retry.
const failedCommandStore = createStore({ resolveAsk: async () => ({ status: 'failed', error: 'Service unavailable' }) });
const store = {
  state: { chapters: {}, byId: {}, projects: [], holds: {}, now: Date.now() },
  async resolveAsk(ask, args) {
    window.askFixture.calls.push({ type: 'resolve', askId: ask.id, ...args });
    if (window.askFixture.fail) throw new Error('Could not reach Loom');
    if (window.askFixture.failDefinitive) return failedCommandStore.resolveAsk(ask, args);
    if (args.step) ask.steps[Number(args.step) - 1].done_at = Date.now();
    if (!args.step || ask.steps.every((s) => s.done_at)) ask.status = 'done';
    draw();
  },
  async replyAsk(itemId, text) { window.askFixture.calls.push({ type: 'reply', itemId, text }); records.find((a) => a.itemId === itemId).status = 'answered'; draw(); },
  async chapterLine(spaceId, line, how) { window.askFixture.calls.push({ type: how, spaceId, line }); },
  async deferAsk(ask, args) { window.askFixture.calls.push({ type: 'defer', askId: ask.id, ...args }); },
  nextOpen(itemId) { window.askFixture.calls.push({ type: 'open', itemId }); },
};
records.forEach((ask, i) => {
  ask.itemId = `sample-${i}`;
  ask.lineId = i + 1;
  const item = { id: ask.itemId, status: { pill: 'needs', detail: ask.text }, facts: { openAsk: ask, name: 'Backup setup' } };
  store.state.byId[item.id] = item;
});
store.state.chapters.sample = { data: { asks: records } };
function draw() {
  render(html`${records.map((ask, i) => html`<article data-shape=${ask.kind}><h2>${['Conversation: to do', 'Catch-up: answer', 'Legacy: reply'][i]}</h2>${i === 0 ? html`<${Needs} item=${store.state.byId[ask.itemId]} store=${store}/>` : i === 1 ? html`<${ChapterBrief} line=${{ id: ask.lineId, data: { askId: ask.id }, title: ask.text, itemId: ask.itemId }} store=${store} spaceId="sample"/>` : html`<${AskCard} ask=${ask} itemId=${ask.itemId} store=${store}/>`}</article>`)}`, document.querySelector('#samples'));
}
window.askFixture.store = store;
window.askFixture.redraw = draw;
draw();
