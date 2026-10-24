import { html, render } from '../vendor/preact-htm.js';
import { createStore } from './store.js';
import { Needs, RuleProposals } from './conversation.js';
import { ChapterBrief } from './next/chapter.js';
import { DecisionSheet } from './next/decision.js';

const now = 1800000000000;
const options = [
  { key: 'A', label: 'Use one shared card', consequence: 'All three surfaces stay consistent. Two sizes fit the available space.', recommended: true },
  { key: 'B', label: 'Keep separate cards', consequence: 'Each surface can change independently, with more upkeep.', recommended: false },
];
const brief = { id: 'D-900', level: 2, class: 'design-direction', tripwire: 'surprise', door: 'two-way', blast: 'private', standing: 'Three surfaces currently draw the same brief differently.', background: 'A shared component keeps the ask and options consistent as the desk changes.', assets: [], optionKeys: ['A', 'B'], revision: 1 };
const ask = 'Use one shared decision card on every surface?';
const pending = { kind: 'question', requestId: 'decision:D-900', at: now - 600000, question: ask, brief, questions: [{ id: 'decision', question: ask, options: options.map(o => ({ label: `${o.key} · ${o.label}${o.recommended ? ' (Recommended)' : ''}`, description: o.consequence })) }] };
const item = { id: 'sample', nextStep: 'your_move', status: { pill: 'needs', detail: ask }, summary: { gist: brief.standing }, facts: { name: 'Decision card design', pending } };
const store = createStore({});
Object.assign(store.state, { now, byId: { sample: item }, holds: {} });
store.openDecision = () => {};
store.chapterAnswer = (...args) => { window.fixtureAnswer = args; };
store.chapterLine = () => {};
store.answerPending = (...args) => { window.fixtureAnswer = args; };
const page = { id: brief.id, class: brief.class, level: brief.level, revision: brief.revision, status: 'open', ask, brief: { ...brief, options }, pending, raisedOn: { itemId: item.id, title: item.facts.name }, changes: [], createdAt: pending.at };
store.state.decisionPage = { id: brief.id, data: page };
store.loadDecision = () => {};
const line = { id: 1, itemId: item.id, briefId: brief.id, title: ask };
const outcome = { by: 'owner-desk', status: 'answered', option: options[0], at: now - 60000, text: 'Keep the same design everywhere.' };
const closedBrief = { ...brief, tripwire: null, status: 'answered', outcome };
const closedPending = { ...pending, brief: closedBrief };
const closedItem = { ...item, facts: { ...item.facts, pending: closedPending } };
// Closed API records carry class/level/revision on the page, outside the raw brief.
const { class: _class, level: _level, revision: _revision, ...rawBrief } = page.brief;
const savedRule = { decisionId: brief.id, choice: 'always', ruleId: 'R-90', ruleState: 'active', text: 'for shared cards, reuse the same component', at: now - 60000, precedent: true };
const closedPage = { ...page, brief: { ...rawBrief, tripwire: null }, status: 'answered', pending: null, outcome, savedRule };
const closedStore = { ...store, state: { ...store.state, decisionPage: { id: brief.id, data: closedPage } } };
const plainAsk = 'Use the shorter introduction?';
const plain = { id: 'plain', nextStep: 'your_move', status: { pill: 'needs', detail: plainAsk }, summary: { gist: 'Use the shorter introduction.' }, facts: { name: 'Introduction' } };
const plainPending = { kind: 'question', requestId: 'plain-question', question: plainAsk, questions: [{ id: 'intro', question: plainAsk, options: [{ label: 'Use it' }, { label: 'Keep the original' }] }] };
const plainWithOptions = { ...plain, id: 'plain-options', summary: { gist: 'The shorter version fits on one screen and keeps the example.' }, facts: { ...plain.facts, pending: plainPending } };
Object.assign(store.state.byId, { plain, 'plain-options': plainWithOptions });
const proposal = { ...savedRule, decisionId: 'D-902', choice: 'once', ruleId: null, ruleState: null, proposal: { state: 'proposed', from: ['D-901', 'D-902'], text: 'Use the shared card for future asks' } };
const historyItem = { ...plain, status: { pill: 'idle' }, summary: { gist: 'The shared card is ready for review.' }, facts: { rulesSaved: [savedRule, proposal, { ...proposal, decisionId: 'D-901' }] } };
closedStore.ruleDecided = store.ruleDecided = (...args) => {
  window.fixtureRule = args;
  const [entry, rule] = args;
  store.state.ruleLocal = { ...store.state.ruleLocal, [entry.decision]: { rule, from: entry.from } };
  closedStore.state.ruleLocal = store.state.ruleLocal;
  draw();
};
window.fixtureSetRule = (choice, ruleState = 'active') => { savedRule.choice = choice; savedRule.ruleState = ruleState; store.state.ruleLocal = {}; closedStore.state.ruleLocal = store.state.ruleLocal; draw(); };
window.fixtureResetProposal = () => { store.state.ruleLocal = {}; closedStore.state.ruleLocal = store.state.ruleLocal; draw(); };
function SheetSample({ store }) {
  return html`<div class="fixture-sheet-stage"><div class="fixture-behind" aria-hidden="true"><h3>Inbox</h3><div><b>Active</b> <span>Waiting</span> <span>Done</span></div><p>A conversation behind the decision sheet</p></div><${DecisionSheet} store=${store}/></div>`;
}
const draw = () => render(html`<section data-surface="thread"><h2>Thread</h2><${Needs} item=${item} store=${store}/><h2>Answered</h2><${Needs} item=${closedItem} store=${store}/></section>
<section data-surface="catchup"><h2>Catch me up</h2><${ChapterBrief} line=${line} brief=${{ ...brief, itemId: item.id, ask, options }} store=${store} spaceId="sample"/><h2>Answered</h2><${ChapterBrief} line=${line} brief=${{ ...closedBrief, itemId: item.id, ask, options }} store=${store} spaceId="sample"/></section>
<section data-surface="decision"><h2>Decision page</h2><${SheetSample} store=${store}/><h2>Answered</h2><${SheetSample} store=${closedStore}/></section>
<section data-surface="plain" style="grid-column:1/-1;max-width:760px;width:100%"><h2>Plain ask</h2><div data-case="repeat"><${Needs} item=${plain} store=${store}/></div><h2>With context and answers</h2><div data-case="context"><${Needs} item=${plainWithOptions} store=${store}/></div></section>
<section data-surface="status" style="grid-column:1/-1;max-width:760px;width:100%"><h2>Thread status and pending proposal</h2><${Needs} item=${historyItem} store=${store}/><${RuleProposals} item=${historyItem} store=${store}/>${['working', 'waiting'].map(pill => html`<${Needs} item=${{ ...historyItem, status: { pill, detail: pill === 'waiting' ? 'Review is pending' : null } }} store=${store}/>` )}</section>`, document.querySelector('#samples'));
draw();
store.subscribe(draw);
// Keep the real sheet's layout visible alongside the other surfaces in this isolated sample.
const style = document.createElement('style');
style.textContent = '.fixture-sheet-stage{position:relative;isolation:isolate}.fixture-behind{position:absolute;inset:0;padding:12px;background:var(--panel)}.fixture-behind b{display:inline-block;padding:10px 18px;background:var(--fg);color:var(--panel);border-radius:24px}.fixture-behind span{padding:8px}.fixture-sheet-stage .rd-scrim{position:relative;display:block;padding:0}.fixture-sheet-stage .rd-modal{position:relative;width:100%;max-height:none}';
document.head.append(style);
window.fixtureUpdated = (why) => { brief.revision = 2; brief.updated = { at: now, why, what: "options" }; draw(); };
window.fixtureUnaddressed = () => { brief.unaddressedAt = now; draw(); };
window.fixtureReady = true;
