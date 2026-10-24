// ?fixtures=1: an in-browser stand-in for the desk API with invented content
// (no real people, threads or data; this repo is public). It implements the same
// interface as api.js, applies commands to its own state, and pushes SSE-like
// updates on timers, so every view and state can be demoed without the server.
//
// Extra URL knobs (fixtures only):
//   view=active|conversation|screen  item=<fixture id>   start on that view
//   operator=idle|live                pin the voice operator instead of cycling it
//   quiet=1                           no timed updates (stable screenshots)
//   draft=listening|confirm|question  show the voice operator's Draft card in that state
//   pause=1|still  waiting=<n>        show the voice operator paused ("Paused · n waiting"; still = 30+ min)
//   clear=1                           everything in rotation was done earlier today (the List's empty Active tab)
//   fail=reply,respond,start,…        those commands (and Start work) fail once each, to see the failure toasts and Retry
//   coordinator=0                     no project coordinators (Desk reliability otherwise has one keeping watch)
//   system=clear                      the System page on a calm day (nothing open, nothing unmanaged)
//   decided=0                         no weekly Delegation review on the Inbox
//   chapter=0                         no catch-up: no chapter on Desk reliability (Where it stands instead), no dots, no Inbox summary
//   nest=1                            nested spaces: Tango holds Desk, Voice and Loom; Sierra holds Bike (docs/specs/spaces.md, Nesting)

import { facetsFor, filterMatches, normalizeFilters } from './filters.js';
import { labelOrderOf } from './list-model.js';
import { matches as queryMatches, openOnly } from './query.js';
import { DEFAULT_VIEWS } from './list-views.js';
import { createSystemFixture } from './system-fixture.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function todayAt(now, hour, minute = 0) {
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

function art(kind, label, url, extra = {}) {
  return { kind, label, url, ...extra };
}

function previewDoc(title, accent, rows) {
  const body = rows.map((w) => `<div style="height:10px;width:${w}%;background:var(--l);border-radius:4px;margin:7px 0"></div>`).join('');
  return (
    'data:text/html;charset=utf-8,' +
    encodeURIComponent(
      `<!doctype html><meta name=viewport content="width=device-width"><style>:root{--bg:#0b0d12;--fg:#c9ced8;--l:#1d2230;--c:#161a22}@media (prefers-color-scheme:light){:root{--bg:#fff;--fg:#2f3644;--l:#e6e9ef;--c:#f3f4f7}}body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:13px system-ui}</style><b>${title}</b>${body}<div style="height:44px;background:var(--c);border-radius:10px;margin-top:12px;border-left:3px solid ${accent}"></div><div style="height:44px;background:var(--c);border-radius:10px;margin-top:8px"></div>`,
    )
  );
}

function sceneDoc(scene) {
  const map = `
<svg viewBox="0 0 1120 640" preserveAspectRatio="xMidYMid slice" style="position:absolute;inset:0;width:100%;height:100%">
<g stroke="var(--line)" fill="none" opacity=".7"><path d="M0,120 C200,90 380,160 560,130 S900,60 1120,110"/><path d="M0,260 C220,230 420,300 640,270 S960,200 1120,240"/><path d="M0,420 C240,390 470,460 700,430 S990,360 1120,400"/><path d="M0,560 C260,530 500,600 740,570 S1000,500 1120,540"/></g>
<path d="M120,520 C220,470 260,360 360,330 S520,300 600,240 S760,140 880,160" fill="none" stroke="#e5b93b" stroke-width="6" stroke-linecap="round"/>
<path d="M600,240 C640,190 690,150 760,120" fill="none" stroke="#f87171" stroke-width="6" stroke-dasharray="10 10" stroke-linecap="round"/>
<path d="M600,240 C680,300 760,320 840,280 S900,200 880,160" fill="none" stroke="#3ecf8e" stroke-width="6" stroke-dasharray="2 12" stroke-linecap="round"/>
<g font-size="15" font-weight="700" fill="var(--fg)"><circle cx="760" cy="120" r="9" fill="#f87171"/><text x="776" y="114">Closure A</text><circle cx="700" cy="160" r="9" fill="#f87171"/><text x="580" y="176">Closure B</text>
<text x="850" y="320" fill="#3ecf8e">Forest-road reroute · +11 mi gravel</text><circle cx="120" cy="520" r="10" fill="var(--fg)"/><text x="140" y="526">Start · trailhead</text></g></svg>
<div class="glass"><h4>Two options</h4><p><b style="color:#3ecf8e">Reroute</b><br>+11 mi, +35 min, all gravel</p><p><b>Drop the north spur</b><br>Finish 40 min earlier</p>
<div class="row"><button data-v="Reroute">Reroute</button><button data-v="Drop it">Drop it</button></div></div>`;
  const diff = `<div class="glass" style="position:static;width:auto;max-width:900px;margin:24px auto"><h4>PR #372 · media reconnect</h4><pre>${[
    '- if (socket.readyState !== OPEN) resend(lastFrame)',
    '+ if (socket.readyState !== OPEN && !hasNewSpeech) return',
    '+ reconnect({ backoffMs: 500, maxMs: 8000 })',
    '  emit("media.reconnected", { attempt })',
  ].join('\n')}</pre><div class="row"><button data-v="Looks good">Looks good</button><button data-v="Hold">Hold</button></div></div>`;
  const html = `<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><style>
:root{--bg:#0b0d12;--fg:#eef0f4;--muted:#8d96a6;--line:#262c38;--card:#161a22}
@media (prefers-color-scheme:light){:root{--bg:#f3f4f7;--fg:#141821;--muted:#5d6676;--line:#dfe3ea;--card:#fff}}
html,body{margin:0;min-height:100%;background:radial-gradient(120% 100% at 30% 20%,color-mix(in srgb,${scene.accent} 14%,var(--bg)),var(--bg));color:var(--fg);font:15px system-ui}
.glass{position:absolute;left:24px;top:24px;width:min(300px,calc(100% - 48px));background:color-mix(in srgb,var(--card) 82%,transparent);border:1px solid var(--line);border-radius:14px;padding:14px}
h4{margin:0 0 8px;font-size:11.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)} p{margin:0 0 8px;color:var(--fg)}
pre{white-space:pre-wrap;font:13px ui-monospace,Menlo,monospace;color:var(--fg)}
.row{display:flex;gap:8px;flex-wrap:wrap}button{font:inherit;color:inherit;background:transparent;border:1px solid var(--line);border-radius:999px;padding:6px 14px;cursor:pointer}
</style></head><body>${scene.layout === 'diff' ? diff : map}<script>
var sceneId=${JSON.stringify(scene.id)};
document.addEventListener('click',function(e){var b=e.target.closest('button[data-v]');if(!b)return;parent.postMessage({type:'input',sceneId:sceneId,input:{type:'choice',data:{value:b.dataset.v}}},'*');});
addEventListener('message',function(e){var m=e.data||{};if(m.type==='command'&&/scroll/.test(m.name))scrollBy({top:m.name==='scroll_up'?-300:300,behavior:'smooth'});});
</script></body></html>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

/** "How we got here" as the server builds it (view.ts threadBeats): every owner message, each agent run's last. */
/** A stand-in picture for fixture messages (an SVG data URL; the live desk serves real ones). */
function fixtureImage(name, label, color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="${color}"/><text x="600" y="420" font-family="system-ui" font-size="64" fill="#fff" text-anchor="middle">${label}</text></svg>`;
  return { name, mimeType: 'image/svg+xml', url: `data:image/svg+xml,${encodeURIComponent(svg)}` };
}

function fixtureBeats(messages) {
  const head = (text) => (String(text).split('\n').find((l) => l.trim()) || '').replace(/[*#>`]/g, '').trim().slice(0, 120);
  return messages
    .filter((m, i) => m.author === 'owner' || (m.author === 'agent' && messages[i + 1]?.author !== 'agent'))
    .map((m) => ({ at: m.at, kind: m.author, headline: head(m.text), messageId: m.messageId }));
}

/**
 * The server evaluates each row's status (desk/status.ts) and sends it; fixture rows have no server, so this stands in
 * from the fixture's own fields, in the same shape (pill, layer, countsForOwner). Fixture data only.
 */
function fixtureStatus(item) {
  const f = item.facts || {};
  const lead = !!f.parentItemId && ['worker', 'ops'].includes(f.role) && !f.ownerGone && !f.leadAway;
  const asks = !!(f.pending || f.openBrief) || item.nextStep === 'your_move';
  const pill = item.nextStep === 'failed' || item.status?.move === 'failed' ? 'failed'
    : asks && !lead && item.source !== 'schedule' ? 'needs'
    : item.nextStep === 'working' || f.running ? 'working'
    : asks || item.nextStep === 'watching' ? 'waiting' : 'idle';
  const placement = item.disposition || 'active';
  const countsForOwner = !lead && (placement === 'active' || (placement === 'done' && pill === 'needs' && !!(f.pending || f.openBrief))) && (pill === 'needs' || pill === 'failed');
  const layer = countsForOwner ? 'needs' : placement === 'done' ? 'done' : placement === 'active' ? 'active' : 'later';
  const live = { needs: 'needs', failed: 'failed', working: 'working', waiting: 'watching', idle: 'fyi' }[pill];
  return { ...(item.status || {}), layer, pill, detail: '', stillWorking: pill === 'working', unread: item.seen !== 'seen', audience: lead ? 'lead' : 'owner', countsForOwner, basis: 'fixture',
    move: pill === 'needs' ? 'needs' : pill === 'failed' ? 'failed' : pill === 'waiting' ? 'watching' : null, busy: pill === 'working' ? 'working' : null, live };
}

function seed(now) {
  const items = [];
  const messages = {};
  const timelines = {};
  const add = (item, msgs = [], beats = []) => {
    const full = {
      source: 'discord',
      kind: 'thread',
      labels: [],
      hidden: false,
      revision: 1,
      disposition: 'active',
      seen: 'seen',
      snoozeUntil: null,
      snoozeTrigger: null,
      backFromSnooze: false,
      doneAt: null,
      writeback: null,
      artifacts: [],
      activity: null,
      watching: null,
      facts: {},
      lastAgentMessageId: `m-${item.id}`,
      lastOwnerMessageAt: null,
      messageCount: msgs.length || 4,
      updatedAt: item.lastActivityAt,
      nextStepBasis: 'summarizer',
      ...item,
    };
    full.conversationKey = full.conversationKey || (full.source === 'loom' ? full.id : `thread:${full.id}`);
    full.status = fixtureStatus(full);
    items.push(full);
    messages[full.id] = msgs.map((m, i) => ({ messageId: `${full.id}-${i}`, ...m }));
    timelines[full.id] = beats;
  };

  // ── Your move ──────────────────────────────────────────────────────
  add(
    {
      id: 'fx-victor-merge',
      agentId: 'victor',
      agentName: 'Victor',
      place: 'operator-dependability',
      area: 'Tango',
      nextStep: 'your_move',
      seen: 'new',
      lastActivityAt: now - 4 * MIN,
      summary: {
        title: 'Merge the reconnect fix?',
        gist: 'Opened PR #372 for the media-reconnect fix. CI is green and both review comments are addressed. The live bot is still on yesterday’s build.',
        step: 'your_move',
        ask: 'Merge and restart the live bot now, or wait until tonight’s quiet window?',
        options: ['Merge now', 'Tonight', 'Hold, I’ll look first'],
        context: [
          'A restart takes about 40 s. Voice reconnects on its own and text turns queue.',
          'Nobody is on voice right now (operator idle).',
          'Tonight’s window is 11 pm. Waiting risks about 9 more reconnects that could double-send.',
          'Rollback is the previous build, about 1 minute.',
        ],
        ownerAsk: 'fix the double-send on media reconnect',
      },
      // D-61: the owner approved a second similar call (D-39, after D-31): Loom proposes one rule, made with one tap.
      facts: { rulesSaved: [{ decisionId: 'D-39', ask: 'Show the reconnect banner only after 5 seconds offline? Recommend: yes.', choice: 'once', ruleId: null, ruleState: null, text: 'Next time, for reconnect banners, show them after 5 seconds offline', at: now - 15 * MIN, precedent: true, proposal: { text: 'Next time, for connection banners, show them only after a few seconds offline without asking', from: ['D-31', 'D-39'], state: 'proposed' } }] },
      artifacts: [art('pr', 'PR #372', 'https://github.com/example/tango/pull/372'), art('ci', 'CI run', 'https://github.com/example/tango/actions/runs/1')],
    },
    [
      { author: 'owner', at: now - 3 * HOUR, text: 'The operator double-sends after a media reconnect. Can you fix it?', attachments: [fixtureImage('double-send.png', 'Two identical replies, 0.4 s apart', '#3b4252')] },
      { author: 'agent', at: now - 170 * MIN, text: 'Looking at the reconnect logs now.' },
      { author: 'agent', at: now - 2 * HOUR, text: 'Reproduced it: the resend path fires even when no new speech arrived.\n\nThe reconnect handler replays the last buffered turn unconditionally. I can gate it on a fresh transcript id.' },
      { author: 'owner', at: now - 110 * MIN, text: 'Gate it, and add a test that reconnects twice in a row.' },
      { author: 'agent', at: now - 70 * MIN, text: 'Done. The gate is in and the double-reconnect test passes. Opened **PR #372**.' },
      { author: 'owner', at: now - 50 * MIN, text: 'Address the two review comments before you ask me to merge.' },
      {
        author: 'agent',
        at: now - 4 * MIN,
        attachments: [fixtureImage('ci-green.png', 'CI: 214 passed', '#1f7a4d'), fixtureImage('reconnect-test.png', 'double-reconnect test ✓', '#2f5f9e')],
        text: 'PR #372 is green. Merge and restart now, or wait until tonight?\n\nThe text path has the same replay bug. Here is a prompt for a separate thread:\n\n```\nIn tango, the text reconnect path replays the last buffered turn the same way voice did before PR #372. Gate it on a fresh message id, as the voice fix does, and add a test that reconnects twice in a row without a new message.\n```',
      },
    ],
    [
      { at: now - 3 * HOUR, kind: 'owner', text: 'You: “fix the double-send on media reconnect”' },
      { at: now - 2 * HOUR, kind: 'agent', text: 'Reproduced: resend fires without new speech' },
      { at: now - 40 * MIN, kind: 'ok', text: 'CI green, review comments addressed' },
      { at: now - 4 * MIN, kind: 'now', text: 'Waiting on you: merge now or tonight' },
    ],
  );

  add(
    {
      id: 'fx-juliet-ferry',
      agentId: 'juliet',
      agentName: 'Juliet',
      place: 'Ferry booking',
      area: 'Home',
      nextStep: 'your_move',
      seen: 'new',
      lastActivityAt: now - 6 * MIN,
      summary: {
        title: 'Book the Saturday sailing?',
        gist: 'The Saturday 9:10 sailing has 2 vehicle spots left. The 11:30 is already full.',
        step: 'your_move',
        ask: 'Book the 9:10 for the truck?',
        options: [],
        context: ['Vehicle + driver fare is $68 round trip.', 'Cancellation is free until Thursday noon.'],
        ownerAsk: 'find a ferry for Saturday morning',
      },
      _replyFailsOnce: true,
    },
    [
      { author: 'owner', at: now - 50 * MIN, text: 'Find me a ferry Saturday morning, truck included.' },
      { author: 'agent', at: now - 6 * MIN, text: 'The 9:10 has 2 vehicle spots left. Book it for the truck?' },
    ],
    [
      { at: now - 50 * MIN, kind: 'owner', text: 'You: “find a ferry for Saturday morning”' },
      { at: now - 6 * MIN, kind: 'now', text: '9:10 has 2 spots, waiting on you' },
    ],
  );

  add(
    {
      id: 'fx-deck-quote',
      agentId: 'foxtrot',
      agentName: 'Foxtrot',
      place: 'Deck stain quote',
      area: 'Home',
      nextStep: 'your_move',
      seen: 'new',
      backFromSnooze: true,
      lastActivityAt: now - 26 * HOUR,
      summary: {
        title: 'Which deck stain bid?',
        gist: 'Two bids are in for staining the back deck: $1,150 with a 2-year warranty, or $890 with none.',
        step: 'your_move',
        ask: 'Go with the warrantied bid or the cheaper one?',
        options: ['Warrantied', 'Cheaper'],
        context: ['Both can start next week.', 'The cheaper crew uses an oil-based stain that needs a re-coat sooner.'],
      },
      artifacts: [art('doc', 'Bid comparison', 'https://example.com/bids')],
    },
    [{ author: 'agent', at: now - 26 * HOUR, text: 'Two bids in. Warrantied ($1,150) or cheaper ($890)?' }],
    [{ at: now - 26 * HOUR, kind: 'now', text: 'Two bids in, waiting on you' }],
  );

  add(
    {
      id: 'loom:fx-empty-state',
      source: 'loom',
      kind: 'loom',
      agentId: 'loom',
      agentName: 'Loom',
      place: 'tango · feat: Inbox empty state',
      area: 'Tango',
      nextStep: 'your_move',
      nextStepBasis: 'loom.pending',
      seen: 'seen',
      lastActivityAt: now - 31 * MIN,
      summary: {
        title: 'Pick an empty-state direction',
        gist: 'Empty-state pass is done, with 14 new tests passing. Three directions are prototyped: a calm illustration, a “since you left” digest, and a plain one-liner.',
        step: 'your_move',
        ask: 'Pick a direction and I’ll open the PR.',
        options: ['Digest', 'Illustration', 'One-liner'],
        context: ['Illustration: friendliest, adds a 14 KB SVG.', 'Digest: most useful, reuses the catch-up endpoint.', 'One-liner: smallest change, matches the rest of the screen.'],
        ownerAsk: 'redo the empty state, it feels broken',
      },
      facts: { },
      artifacts: [
        art('preview', 'A · Illustration', previewDoc('Preview A · Illustration', '#60a5fa', [40, 60, 30])),
        art('preview', 'B · Since-you-left digest', previewDoc('Preview B · Since you left', '#a78bfa', [70, 85, 55])),
        art('preview', 'C · One-liner', previewDoc('Preview C · One-liner', '#8d96a6', [50])),
        art('diff', 'Diff', 'https://github.com/example/tango/compare/main...empty-state'),
      ],
    },
    [
      { author: 'owner', at: now - 3 * HOUR, text: 'Redo the empty state, it feels broken.' },
      { author: 'agent', at: now - 31 * MIN, text: 'Three directions prototyped. Pick one and I’ll open the PR.' },
    ],
    [
      { at: now - 3 * HOUR, kind: 'owner', text: 'You: “redo the empty state, it feels broken”' },
      { at: now - 2 * HOUR, kind: 'agent', text: 'Audited the 4 empty paths, found 2 that render blank' },
      { at: now - 50 * MIN, kind: 'ok', text: '14 tests added, all passing' },
      { at: now - 31 * MIN, kind: 'now', text: 'Prototyped 3 directions, waiting on you' },
    ],
  );

  // A Loom thread blocked on two questions at once (the shape Loom sends: ids are the question text).
  const reviewQ = 'Once CI is green I’ll mark PR #412 ready for review. Who should I request as reviewer?';
  const mergeQ = 'Once all review threads are resolved and CI is green again, should I merge the PR?';
  add(
    {
      id: 'loom:fx-review-merge',
      source: 'loom',
      kind: 'thread',
      agentId: 'loom',
      agentName: 'Loom',
      place: 'tango · Memory bank budget',
      area: 'Tango',
      nextStep: 'your_move',
      nextStepBasis: 'source:question',
      seen: 'new',
      lastActivityAt: now - 2 * MIN,
      ask: `${reviewQ} (+1 more)`,
      options: ['Storage + prompt leads (Recommended)', 'Storage lead only', 'Prompt lead only', 'Don’t request anyone'],
      summary: {
        title: 'Reviewer and merge plan for PR #412',
        gist: 'The memory-bank budget fix is pushed; CI is running. Two questions before it goes on: who reviews, and whether to merge once unblocked.',
        step: 'your_move',
        ask: null,
        options: [],
        context: ['The PR touches both the storage layer and prompt construction.'],
        ownerAsk: 'fix the memory bank overflowing the prompt budget',
      },
      facts: {
        running: { since: now - 20 * MIN, lastAt: now - 2 * MIN },
        pending: {
          kind: 'question',
          requestId: 'fx-req-1',
          at: now - 2 * MIN,
          question: `${reviewQ} (+1 more)`,
          options: ['Storage + prompt leads (Recommended)', 'Storage lead only', 'Prompt lead only', 'Don’t request anyone'],
          questions: [
            {
              id: reviewQ,
              header: 'Reviewer',
              question: reviewQ,
              multiSelect: false,
              options: [
                { label: 'Storage + prompt leads (Recommended)', description: 'One wrote most of the storage code; the other owns prompt construction. This PR changes both.' },
                { label: 'Storage lead only', description: 'One reviewer for the whole PR; lighter, but nobody who owns the prompt side looks at the budget change.' },
                { label: 'Prompt lead only', description: 'The prompt side is covered; the client and storage changes get a less familiar reviewer.' },
                { label: 'Don’t request anyone', description: 'I mark it ready and leave reviewer assignment to you.' },
              ],
            },
            {
              id: mergeQ,
              header: 'Merge',
              question: mergeQ,
              multiSelect: false,
              options: [
                { label: 'Merge when unblocked (Recommended)', description: 'The existing approval stands; I merge as soon as GitHub allows it.' },
                { label: 'Wait for a second review', description: 'Hold the merge until another requested reviewer also signs off.' },
                { label: 'I’ll merge it myself', description: 'I get it unblocked and stop there.' },
              ],
            },
          ],
        },
      },
      artifacts: [art('pr', 'PR #412', 'https://github.com/example/tango/pull/412')],
    },
    [
      { author: 'owner', at: now - 40 * MIN, text: 'Fix the memory bank overflowing the prompt budget.' },
      { author: 'agent', at: now - 2 * MIN, text: 'Pushed the fix; CI is running. Two questions before I go on.' },
    ],
    [
      { at: now - 40 * MIN, kind: 'owner', text: 'You: “fix the memory bank overflowing the prompt budget”' },
      { at: now - 2 * MIN, kind: 'now', text: 'Waiting on you: reviewer and merge plan' },
    ],
  );

  // A level 1 brief behind a tripwire, with a deadline: the owner's call, no rule chips, a due pill.
  {
    const ask = 'Run one sudo command so the first backup finishes in about 6 hours instead of 33?';
    const options = ['A · Lift the throttle for this backup (Recommended)', 'B · Pause automatic backups', 'C · Do nothing'];
    add(
      {
        id: 'loom:fx-brief-l1', source: 'loom', kind: 'thread', agentId: 'loom', agentName: 'Loom',
        place: 'tango · Machine health', area: 'Tango', nextStep: 'your_move', nextStepBasis: 'source:question', seen: 'new',
        lastActivityAt: now - 6 * MIN, ask, options,
        summary: { title: 'Backup throttle', gist: 'The first backup is crawling; one command speeds it up.', step: 'your_move', ask: null, options: [], context: [] },
        facts: {
          pending: {
            kind: 'question', requestId: 'decision:D-44', at: now - 6 * MIN, question: ask, options,
            questions: [{ id: 'decision', header: 'Your options', question: ask, multiSelect: false, allowCustomAnswer: true, options: [
              { label: options[0], description: 'Finishes in about 6 hours; later backups are small. Other disk work may feel slower while it runs. Resets on reboot.' },
              { label: options[1], description: 'The disk stays safe, but there is no backup until you turn them back on.' },
              { label: options[2], description: 'The backup resumes throttled and its snapshot refills the disk in about 12 hours. It never finishes.' },
            ] }],
            brief: {
              id: 'D-44', class: 'credentials-identity', level: 1, candidate: false, door: 'two-way', blast: 'private', tripwire: 'identity',
              standing: 'The disk hit 97%. I stopped the backup and cleared old worktrees; it has 65 GB free now. The backup restarts on its own within the hour.',
              background: 'The first backup runs as low-priority disk work, about 5 MB/s, while the network drive can take 47 MB/s. Its local snapshot grows about 5 GB an hour until it finishes.',
              assets: [{ kind: 'pr', title: 'PR #803 · disk-space alert', url: 'https://github.com/example/tango/pull/803' }],
              deadline: 'Within about 1 h, when the automatic backup restarts.', defaultOption: null, vetoLeftMs: null,
              proposedRule: null, confidence: 'medium', changeMyMind: 'If the network drive is the bottleneck, lifting the throttle will not help much and B is safer.',
            },
          },
        },
      },
      [{ author: 'agent', at: now - 6 * MIN, text: 'Decision D-44 is on the desk.' }],
      [{ at: now - 6 * MIN, kind: 'now', text: 'Waiting on you: decision D-44' }],
    );
  }

  // A Loom thread with a decision brief (decisions phase 3): a promotion candidate, so the rule chips show.
  const briefAsk = 'Show the veto countdown as active time left? Recommend: yes.';
  add(
    {
      id: 'loom:fx-brief',
      source: 'loom',
      kind: 'thread',
      agentId: 'loom',
      agentName: 'Loom',
      place: 'tango · Veto countdown copy',
      area: 'Tango',
      nextStep: 'your_move',
      nextStepBasis: 'source:question',
      seen: 'new',
      lastActivityAt: now - 4 * MIN,
      ask: briefAsk,
      options: ['A · Active time left (Recommended)', 'B · A clock time'],
      summary: { title: 'Veto countdown copy', gist: 'The countdown is built; one copy call before the PR.', step: 'your_move', ask: null, options: [], context: [] },
      facts: {
        pending: {
          kind: 'question',
          requestId: 'decision:D-42',
          at: now - 4 * MIN,
          question: briefAsk,
          options: ['A · Active time left (Recommended)', 'B · A clock time'],
          questions: [{ id: 'decision', header: 'Your options', question: briefAsk, multiSelect: false, allowCustomAnswer: true, options: [
            { label: 'A · Active time left (Recommended)', description: 'Honest about what the timer counts; it pauses while you are idle.' },
            { label: 'B · A clock time', description: 'Familiar, but wrong whenever you go idle.' },
          ] }],
          brief: {
            id: 'D-42', class: 'product-choice-in-scope', level: 3, candidate: true, door: 'two-way', blast: 'private', tripwire: null,
            standing: 'The veto clock counts active time; the card needs a label, the one D-6 will use too.',
            background: 'D-1 set the veto window to 4 hours of active time, paused while idle.',
            assets: [{ kind: 'pr', title: 'PR #760', url: 'https://github.com/example/tango/pull/760' }],
            deadline: null, defaultOption: 'A', vetoLeftMs: 2 * HOUR + 10 * MIN,
            proposedRule: 'Next time, for desk timer copy, use active time without asking', confidence: 'high', changeMyMind: null, precedentOf: 'D-27',
          },
        },
      },
    },
    [
      { author: 'owner', at: now - 50 * MIN, text: 'Put a countdown on level 3 briefs.' },
      { author: 'agent', at: now - 4 * MIN, text: 'Countdown built. Decision D-42 is on the desk.' },
    ],
    [
      { at: now - 50 * MIN, kind: 'owner', text: 'You: “put a countdown on level 3 briefs”' },
      { at: now - 4 * MIN, kind: 'now', text: 'Waiting on you: decision D-42' },
    ],
  );
  // A space lead carrying its worker's decision brief, passed up intact (desk/asks.ts carryBriefs): the full brief
  // shows on the lead, labelled where it came from, and counts once, there; the worker says who carries it.
  {
    const from = { itemId: 'loom:fx-filter', title: 'Filter System Audit and Upgrade' };
    const ask = 'Finish the filter upgrade: steps 4, 6 and 7? Recommend: all three.';
    const options = ['A · Build 4, 6 and 7 (Recommended)', 'B · Only step 6', 'C · Stop after step 5'];
    const pending = {
      kind: 'question',
      requestId: 'decision:D-6',
      at: now - 25 * MIN,
      question: ask,
      options,
      questions: [{ id: 'decision', header: 'Your options', question: ask, multiSelect: false, allowCustomAnswer: true, options: [
        { label: options[0], description: 'About two days; the whole plan ships' },
        { label: options[1], description: 'Half a day; 4 and 7 wait for the next round' },
        { label: options[2], description: 'Nothing more is built; the half-built step 5 stays behind a flag' },
      ] }],
      brief: {
        id: 'D-6', class: 'plan-approval', level: 2, candidate: true, door: 'two-way', blast: 'private',
        standing: 'Steps 1 to 3 are live; step 5 is half built behind a flag.',
        background: 'The desk filter upgrade has seven steps. The first three were approved and shipped; 4, 6 and 7 add saved filters, mutes per space and a filter bar on the List.',
        assets: [{ kind: 'pr', title: 'PR #759', url: 'https://github.com/example/tango/pull/759' }],
        deadline: null, defaultOption: null, vetoLeftMs: null,
        proposedRule: 'Next time, for steps already in an approved plan, build them without asking',
        confidence: 'high', changeMyMind: null, from,
        revision: 2, updated: { at: now - 10 * MIN, what: 'recommendation B → A · options', why: 'Step 6 turned out to need step 4 first' },
      },
    };
    add(
      {
        id: 'loom:fx-desk-lead', source: 'loom', kind: 'thread', agentId: 'loom', agentName: 'Loom',
        place: 'tango · Tango Desk', area: 'Tango', nextStep: 'your_move', nextStepBasis: 'source:ask', seen: 'new',
        lastActivityAt: now - 4 * MIN, ask, options,
        summary: { title: 'Filter work waits on D-6', gist: 'The filter worker raised D-6; nothing else is blocked.', step: 'your_move', ask: null, options: [], context: [] },
        facts: { role: 'default', pending, carried: [{ from, pending, why: 'worker', counts: true }] },
      },
      [{ author: 'agent', at: now - 4 * MIN, text: 'The filter worker is waiting on one call.\n\n**Next — you:** D-6.' }],
    );
    add(
      {
        id: 'loom:fx-filter', source: 'loom', kind: 'thread', agentId: 'loom', agentName: 'Loom',
        place: 'tango · Filter System Audit and Upgrade', area: 'Tango', nextStep: 'your_move', nextStepBasis: 'source:question', seen: 'seen',
        lastActivityAt: now - 25 * MIN, ask, options,
        askRecord: { source: 'pending', text: ask, kind: 'decision', kindBy: 'source', at: now - 25 * MIN, dueAt: null, key: 'fx-d6', state: 'duplicate', of: 'loom:fx-desk-lead' },
        summary: { title: 'Brief D-6 is up', gist: 'Waiting on D-6 before building past step 5.', step: 'your_move', ask: null, options: [], context: [] },
        facts: { role: 'worker', parentItemId: 'loom:fx-desk-lead', pending: { ...pending, brief: { ...pending.brief, from: undefined } }, carriedBy: { itemId: 'loom:fx-desk-lead', title: 'Tango Desk' } },
      },
      [{ author: 'agent', at: now - 25 * MIN, text: 'Brief D-6 is up.' }],
    );
  }

  // A Loom thread blocked on an approval.
  add(
    {
      id: 'loom:fx-migrate',
      source: 'loom',
      kind: 'thread',
      agentId: 'loom',
      agentName: 'Loom',
      place: 'tango · Desk storage migration',
      area: 'Tango',
      nextStep: 'your_move',
      nextStepBasis: 'source:approval',
      seen: 'seen',
      lastActivityAt: now - 9 * MIN,
      ask: 'Run: npm run migrate -- --apply (rewrites desk_items in the dev database)',
      options: ['Approve', 'Always allow this session', 'Decline'],
      summary: { title: 'Run the storage migration?', gist: 'The migration script is written and dry-run clean; it needs approval to apply.', step: 'your_move', ask: null, options: [], context: [] },
      facts: {
        pending: {
          kind: 'approval',
          requestId: 'fx-ap-1',
          at: now - 9 * MIN,
          questions: [],
          question: 'Run: npm run migrate -- --apply (rewrites desk_items in the dev database)',
          options: ['Approve', 'Always allow this session', 'Decline'],
          approval: {
            requestKind: 'command',
            detail: 'Run: npm run migrate -- --apply (rewrites desk_items in the dev database)',
            options: [
              { decision: 'accept', label: 'Approve' },
              { decision: 'acceptForSession', label: 'Always allow this session', warning: 'Later commands like this run without asking' },
              { decision: 'decline', label: 'Decline' },
            ],
          },
        },
      },
    },
    [
      {
        author: 'agent',
        at: now - 9 * MIN,
        text: 'Dry run is clean. I need approval to apply the migration.\n\n```\nnpm run migrate -- --apply --database ./data/dev.db --table desk_items --batch-size 500 --log ./logs/migrate-desk-items.log\nrewrote 1,284 rows in 3 batches; 0 skipped; indexes rebuilt (desk_items_by_state, desk_items_by_activity)\n```',
      },
    ],
    [{ at: now - 9 * MIN, kind: 'now', text: 'Waiting on your approval' }],
  );

  add(
    {
      id: 'fx-sierra-loop',
      agentId: 'sierra',
      agentName: 'Sierra',
      place: 'Ridge Loop loop planning',
      area: 'Trips',
      nextStep: 'your_move',
      seen: 'seen',
      lastActivityAt: now - 2 * DAY,
      summary: {
        title: 'Reroute or drop the north spur?',
        gist: 'Two closures went up Tuesday on the north spur.',
        step: 'your_move',
        ask: 'Reroute via the forest road (+11 mi gravel) or drop that leg?',
        options: ['Reroute', 'Drop it'],
        context: ['2 closures posted Tuesday.', 'The reroute has no unplated sections and adds about 35 min.', 'Dropping the leg finishes 40 min earlier.'],
        ownerAsk: 'can we still do the loop Saturday',
      },
      artifacts: [
        art('prototype', 'Closures map with the forest-road reroute', 'https://example.com/map'),
        art('doc', 'Ride book p.14: Ridge Loop loop', 'https://example.com/ridebook'),
        art('file', 'Closure order photos: North gate', 'https://example.com/closure-north.jpg'),
        art('file', 'Closure order photos: Creek bridge', 'https://example.com/closure-bridge.jpg'),
        art('link', 'Forest Service alert, posted Tuesday', 'https://example.com/alert'),
      ],
    },
    [
      { author: 'owner', at: now - 2 * DAY - HOUR, text: 'Can we still do the loop Saturday?' },
      { author: 'agent', at: now - 2 * DAY, text: 'Two closures on the north spur. Reroute (+11 mi gravel) or drop the leg?' },
    ],
    [
      { at: now - 2 * DAY - HOUR, kind: 'owner', text: 'You: “can we still do the loop Saturday”' },
      { at: now - 2 * DAY, kind: 'now', text: 'Closures found, waiting on you' },
    ],
  );

  // ── Failed ─────────────────────────────────────────────────────────
  add(
    {
      id: 'loom:fx-health',
      source: 'loom',
      kind: 'loom',
      agentId: 'loom',
      agentName: 'Loom',
      place: 'tango · bug: Health-check tuning',
      area: 'Tango',
      nextStep: 'failed',
      nextStepBasis: 'loom.turn.failed',
      seen: 'new',
      lastActivityAt: now - 7 * MIN,
      summary: {
        title: 'Health-check tuning failed',
        gist: 'The turn errored after editing health-check.ts.',
        step: 'your_move',
        ask: null,
        options: [],
        context: [],
        ownerAsk: 'lower the stuck-I/O threshold and add a test for it',
      },
      facts: { failed: { at: now - 7 * MIN, reason: 'overloaded', message: 'Turn errored: provider overloaded (529) after 3 retries' }, lastGoodStep: 'edited health-check.ts · tests not run yet', },
    },
    [{ author: 'owner', at: now - 20 * MIN, text: 'Lower the stuck-I/O threshold and add a test for it.' }],
    [
      { at: now - 20 * MIN, kind: 'owner', text: 'You: “lower the stuck-I/O threshold”' },
      { at: now - 12 * MIN, kind: 'agent', text: 'Edited health-check.ts' },
      { at: now - 7 * MIN, kind: 'fail', text: 'Provider overloaded (529) after 3 retries' },
    ],
  );

  // ── Working ────────────────────────────────────────────────────────
  add(
    {
      id: 'fx-watson-receipts',
      agentId: 'watson',
      agentName: 'Watson',
      place: 'Quarterly receipts',
      area: 'Home',
      nextStep: 'working',
      nextStepBasis: 'turn.started',
      seen: 'seen',
      lastActivityAt: now - 12 * MIN,
      lastOwnerMessageAt: now - 12 * MIN,
      summary: {
        title: 'Matching Q3 receipts',
        gist: '29 of 41 matched, 2 flagged so far.',
        step: 'fyi',
        ask: null,
        options: [],
        context: [],
        ownerAsk: 'match Q3 receipts to the card statements and flag anything without a receipt.',
      },
      activity: { text: '29 of 41 matched · 2 flagged so far', at: now - 8000, lines: [] },
      facts: { approach: 'date + amount match, then vendor fuzzy match' },
    },
    [{ author: 'owner', at: now - 12 * MIN, text: 'Match Q3 receipts to the card statements and flag anything without a receipt.' }],
    [
      { at: now - 12 * MIN, kind: 'owner', text: 'You: “match Q3 receipts to the statements”' },
      { at: now - 10 * MIN, kind: 'agent', text: 'Pulled 41 statement lines' },
    ],
  );

  add(
    {
      id: 'loom:fx-new-setup',
      source: 'loom',
      kind: 'loom',
      agentId: 'loom',
      agentName: 'Loom',
      place: 'acme · Scenario import keeps tags',
      area: 'acme',
      nextStep: 'working',
      nextStepBasis: 'source:running',
      seen: 'new',
      lastActivityAt: now - 20_000,
      lastOwnerMessageAt: now - 25_000,
      summary: { title: 'Scenario import keeps tags', gist: 'Just started from the desk.', step: 'fyi', ask: null, options: [], context: [], ownerAsk: 'fix the scenario import so tags survive, then add a test.' },
      facts: {
        running: { since: now - 25_000 },
        setup: {
          phase: 'running',
          startedAt: now - 25_000,
          error: null,
          stages: [
            { id: 'fetch', status: 'done', percent: null },
            { id: 'checkout', status: 'running', percent: 42 },
            { id: 'submodules', status: 'skipped', percent: null },
            { id: 'setup-script', status: 'pending', percent: null },
            { id: 'agent', status: 'pending', percent: null },
          ],
        },
      },
    },
    [{ author: 'owner', at: now - 25_000, text: 'Fix the scenario import so tags survive, then add a test.' }],
    [{ at: now - 25_000, kind: 'owner', text: 'You: “fix the scenario import”' }],
  );

  add(
    {
      id: 'loom:fx-webhooks',
      source: 'loom',
      kind: 'loom',
      agentId: 'loom',
      agentName: 'Loom',
      place: 'acme · ops: Billing webhooks',
      area: 'Acme',
      nextStep: 'working',
      nextStepBasis: 'loom.turn.running',
      seen: 'seen',
      lastActivityAt: now - 41 * MIN,
      lastOwnerMessageAt: now - 41 * MIN,
      summary: {
        title: 'Billing webhook retries',
        gist: 'Integration suite still running.',
        step: 'fyi',
        ask: null,
        options: [],
        context: [],
        ownerAsk: 'add retry handling to the billing webhooks and run the integration suite.',
      },
      activity: { text: 'Running: yarn test:integration --filter webhooks', at: now - 14 * MIN, lines: [] },
      facts: { },
    },
    [{ author: 'owner', at: now - 41 * MIN, text: 'Add retry handling to the billing webhooks and run the integration suite.' }],
    [
      { at: now - 41 * MIN, kind: 'owner', text: 'You: “add retry handling to the billing webhooks”' },
      { at: now - 20 * MIN, kind: 'ok', text: 'Retry handling added, unit tests pass' },
      { at: now - 14 * MIN, kind: 'agent', text: 'Started the integration suite' },
    ],
  );

  // ── Watching ───────────────────────────────────────────────────────
  add(
    {
      id: 'fx-victor-feedback',
      agentId: 'victor',
      agentName: 'Victor',
      place: 'Reconnect fix · feedback',
      area: 'Tango',
      nextStep: 'watching',
      nextStepBasis: 'background_job',
      seen: 'seen',
      lastActivityAt: now - 2 * HOUR,
      summary: {
        title: 'Watching reconnect feedback',
        gist: 'Watching Discord feedback on the reconnect fix since it shipped. 3 reports so far, none about voice dropping.',
        step: 'watching',
        ask: null,
        options: [],
        context: [],
        watchUntil: new Date(todayAt(now, 18)).toISOString(),
      },
      watching: { nextCheckAt: todayAt(now, 18), reason: 'background job' },
      facts: { job: { id: 'job-feedback-scan', agentId: 'malibu', label: 'feedback-scan', startedAt: now - 2 * HOUR, deadlineAt: null } },
      artifacts: [art('doc', 'Feedback log', 'https://example.com/feedback')],
    },
    [{ author: 'agent', at: now - 2 * HOUR, text: 'Watching feedback through the evening. 3 reports, none about voice.' }],
    [{ at: now - 2 * HOUR, kind: 'agent', text: 'Started background job “feedback-scan”' }],
  );

  // Waiting on a team member: a Watching variant.
  add(
    {
      id: 'loom:fx-search-pr',
      source: 'loom',
      kind: 'loom',
      agentId: 'loom',
      agentName: 'Loom',
      place: 'acme · bug:Search ranking',
      area: 'Acme',
      nextStep: 'watching',
      nextStepBasis: 'loom.pr.review',
      seen: 'seen',
      lastActivityAt: now - 2 * DAY - 3 * HOUR,
      summary: { title: 'Waiting on a review', gist: 'Opened PR #381 with the ranking tweak; tests pass.', step: 'watching', ask: null, options: [], context: [] },
      watching: { reason: 'pr review', waitingOn: { who: 'Ravi', what: 'PR #381 review requested', since: now - 2 * DAY - 3 * HOUR } },
      facts: { },
      artifacts: [art('pr', 'PR #381', 'https://github.com/example/acme/pull/381')],
    },
    [{ author: 'agent', at: now - 2 * DAY - 3 * HOUR, text: 'PR #381 is up; requested a review from Ravi.' }],
    [
      { at: now - 2 * DAY - 5 * HOUR, kind: 'owner', text: 'You: “tune the search ranking for short queries”' },
      { at: now - 2 * DAY - 3 * HOUR, kind: 'ok', text: 'Opened PR #381, review requested from Ravi' },
    ],
  );

  add(
    {
      id: 'fx-juliet-tiles',
      agentId: 'juliet',
      agentName: 'Juliet',
      place: 'Kitchen tile samples',
      area: 'Home',
      nextStep: 'watching',
      seen: 'seen',
      lastActivityAt: now - 5 * HOUR,
      summary: { title: 'Waiting on feedback', gist: 'Sent the three tile samples to Mara for her pick.', step: 'watching', ask: null, options: [], context: [] },
      watching: { reason: 'feedback', waitingOn: { who: 'Mara', what: 'feedback on the tile samples', since: now - 5 * HOUR } },
    },
    [{ author: 'agent', at: now - 5 * HOUR, text: 'Sent the samples to Mara; I’ll pass on her pick.' }],
    [{ at: now - 5 * HOUR, kind: 'agent', text: 'Sent samples to Mara' }],
  );

  add(
    {
      id: 'loom:fx-export-pr',
      source: 'loom',
      kind: 'loom',
      agentId: 'loom',
      agentName: 'Loom',
      place: 'acme · chore: Invoice export',
      area: 'Acme',
      nextStep: 'your_move',
      nextStepBasis: 'watching.quiet',
      seen: 'new',
      lastActivityAt: now - 4 * DAY,
      summary: {
        title: 'Still waiting on a review',
        gist: 'PR #380 has waited 4 days for review. Nothing else is blocked on it yet.',
        step: 'your_move',
        ask: 'Still waiting on Ana (PR #380 review) — nudge?',
        options: [],
        context: ['Ana was requested as reviewer on Thursday.', 'The export change is behind a flag, so merging late is low risk.'],
      },
      watching: { reason: 'pr review', waitingOn: { who: 'Ana', what: 'PR #380 review', since: now - 4 * DAY } },
      facts: { },
      artifacts: [art('pr', 'PR #380', 'https://github.com/example/acme/pull/380')],
    },
    [{ author: 'agent', at: now - 4 * DAY, text: 'PR #380 is up; review requested from Ana.' }],
    [
      { at: now - 4 * DAY, kind: 'ok', text: 'Opened PR #380, review requested from Ana' },
      { at: now - 2 * HOUR, kind: 'now', text: 'Watching went quiet: still no review' },
    ],
  );

  // ── FYI ────────────────────────────────────────────────────────────
  add(
    {
      id: 'loom:fx-voice',
      source: 'loom',
      kind: 'loom',
      agentId: 'loom',
      agentName: 'Loom',
      place: 'tango · Voice reconnect',
      area: 'Tango',
      nextStep: 'fyi',
      seen: 'new',
      lastActivityAt: now - 3 * HOUR,
      summary: { title: 'Merged and redeployed', gist: 'Merged #367 and redeployed the live bot. No errors in the 30 minutes since.', step: 'fyi', ask: null, options: [], context: [] },
      artifacts: [art('pr', 'PR #367', 'https://github.com/example/tango/pull/367')],
      _writebackFailsOnce: true,
    },
    [{ author: 'agent', at: now - 3 * HOUR, text: 'Merged #367 and redeployed. Quiet for 30 min.' }],
    [{ at: now - 3 * HOUR, kind: 'ok', text: 'Merged #367, redeployed' }],
  );

  add(
    {
      id: 'fx-malibu-training',
      agentId: 'malibu',
      agentName: 'Malibu',
      place: 'Training block',
      area: 'Health',
      nextStep: 'fyi',
      seen: 'updated',
      lastActivityAt: now - 25 * MIN,
      summary: { title: 'Week 3 adjusted', gist: 'Shifted Thursday’s long run to Friday after the rain forecast. Week 3 volume unchanged.', step: 'fyi', ask: null, options: [], context: [] },
    },
    [{ author: 'agent', at: now - 25 * MIN, text: 'Moved Thursday’s long run to Friday (rain). Volume unchanged.' }],
    [],
  );

  add(
    {
      id: 'fx-watson-chat',
      kind: 'chapter',
      agentId: 'watson',
      agentName: 'Watson',
      place: 'chat',
      area: 'Home',
      nextStep: 'fyi',
      seen: 'seen',
      conversationKey: 'channel:fx-watson',
      lastActivityAt: now - 18 * MIN,
      summary: { title: 'Meeting moved', gist: 'Moved the 2pm to Thursday; Ana confirmed.', step: 'fyi', ask: null, options: [], context: [] },
    },
    [{ author: 'agent', at: now - 18 * MIN, text: 'Moved the 2pm to Thursday; Ana confirmed.' }],
    [],
  );

  // ── Snoozed / parked ───────────────────────────────────────────────
  const snoozed = (id, agentId, agentName, place, area, extra) =>
    add({ id, agentId, agentName, place, area, nextStep: 'your_move', seen: 'seen', lastActivityAt: now - 5 * HOUR, summary: { gist: place, step: 'your_move', ask: null, options: [], context: [] }, ...extra });
  snoozed('fx-gutter-review', 'watson', 'Watson', 'Gutter quote PDF review', 'Home', { disposition: 'snoozed', snoozeTrigger: 'desk', updatedAt: now - HOUR, summary: { gist: 'Needs the big screen: a 6-page quote to compare line by line.', step: 'your_move', options: [], context: [] } });
  snoozed('fx-shelving', 'foxtrot', 'Foxtrot', 'Garage shelving plan', 'Home', { disposition: 'snoozed', snoozeTrigger: 'desk', updatedAt: now - 3 * HOUR, summary: { gist: 'Snoozed from the phone.', step: 'your_move', options: [], context: [] } });
  snoozed('fx-thresholds', 'victor', 'Victor', 'Health-check thresholds', 'Tango', { disposition: 'snoozed', snoozeUntil: new Date(todayAt(now, 18) > now ? todayAt(now, 18) : todayAt(now + DAY, 9)).toISOString() });
  snoozed('fx-renewal', 'watson', 'Watson', 'Insurance renewal quotes', 'Home', { disposition: 'snoozed', snoozeUntil: new Date(now + 2 * HOUR).toISOString(), lastActivityAt: now - 5 * DAY });
  snoozed('fx-trailer', 'sierra', 'Sierra', 'Trailer brake check', 'Trips', { disposition: 'snoozed', snoozeUntil: new Date(todayAt(now + 4 * DAY, 10)).toISOString(), lastActivityAt: now - 10 * 60000 });
  snoozed('loom:fx-search', 'loom', 'Loom', 'acme · Search tuning', 'Acme', { source: 'loom', kind: 'loom', disposition: 'snoozed', snoozeTrigger: 'agent_posts', summary: { gist: 'Waiting on PR #2210 to merge.', step: 'watching', options: [], context: [] } });
  snoozed('fx-van', 'sierra', 'Sierra', 'Camper van conversion research', 'Trips', { disposition: 'parked', updatedAt: now - 9 * DAY, lastActivityAt: now - 9 * DAY });
  snoozed('fx-mealplan', 'malibu', 'Malibu', 'Meal plan v2', 'Health', { disposition: 'parked', updatedAt: now - 3 * DAY, lastActivityAt: now - 3 * DAY });

  // ── History (done, mostly chapters) ────────────────────────────────
  const chapter = (id, agentId, agentName, title, gist, at, extra = {}) =>
    add({
      id,
      kind: 'chapter',
      agentId,
      agentName,
      place: title,
      area: 'Home',
      conversationKey: `channel:fx-${agentId}`,
      nextStep: 'fyi',
      disposition: 'done',
      doneAt: at + 30 * MIN,
      writeback: { action: 'done', outcome: 'ok', at: now - HOUR },
      lastActivityAt: at,
      summary: { title, gist, step: 'fyi', options: [], context: [] },
      ...extra,
    });
  chapter('fx-ch-tides', 'foxtrot', 'Foxtrot', 'Tide pools', 'Low tide 3:52 pm, −0.4 ft', Math.min(now - 20 * MIN, todayAt(now, 14, 5)), { messageCount: 2 });
  chapter('fx-ch-gutter', 'foxtrot', 'Foxtrot', 'Gutter quote', 'Compared 2 bids, recommended the local crew', Math.min(now - 40 * MIN, todayAt(now, 11, 45)), { messageCount: 6, artifacts: [art('doc', 'Bid comparison', 'https://example.com/bids')] });
  chapter('fx-ch-lunch', 'malibu', 'Malibu', 'Lunch log', 'Chicken bowl · 1,320 / 2,100 kcal', Math.min(now - 30 * MIN, todayAt(now, 12, 40)), { messageCount: 3 });
  chapter('fx-ch-breakfast', 'malibu', 'Malibu', 'Breakfast + workout plan', 'Logged oats, swapped legs → upper', Math.min(now - 50 * MIN, todayAt(now, 7, 15)), { messageCount: 5 });
  chapter('fx-ch-brief', 'watson', 'Watson', 'Morning brief', '3 meetings, 1 bill due Friday', Math.min(now - 60 * MIN, todayAt(now, 6, 30)), { messageCount: 4 });
  chapter('fx-ch-yesterday', 'victor', 'Victor', 'Health check alerts', 'Alerts now route to one channel', now - DAY - 2 * HOUR, { kind: 'thread', conversationKey: 'thread:fx-ch-yesterday', messageCount: 9 });

  // ── Spaces: jobs and workers (thread roles, docs/specs/spaces.md) ────
  // A job: standing work that runs on a schedule and reports to its space's default. A worker: one job, then gone.
  const runs = (list) => list.map(([ago, outcome, note]) => ({ at: now - ago, outcome, note }));
  const job = (id, agentId, agentName, title, schedule, gist, extra = {}) =>
    add({
      id, source: 'schedule', agentId, agentName, place: title, area: 'Jobs', nextStep: 'fyi', seen: 'seen',
      lastActivityAt: schedule.lastRunAt, summary: { title, gist, step: 'fyi', options: [], context: [] },
      ...extra,
      // As desk/status.ts says it: a job has no move unless it failed.
      status: { move: extra.nextStep === 'failed' ? 'failed' : null, busy: null },
      facts: { role: 'ops', schedule, ...(extra.facts || {}) },
    });
  job('fx-job-brief', 'watson', 'Watson', 'Morning brief', { every: 'Daily 6:30', lastRunAt: now - 5 * HOUR, nextRunAt: now + 19 * HOUR },
    'Brief posted: 3 meetings, 1 bill due Friday.',
    { facts: { parentItemId: 'fx-watson-chat', runs: runs([[5 * HOUR, 'ok', 'Posted the brief'], [29 * HOUR, 'ok', 'Posted the brief'], [53 * HOUR, 'quiet', 'Nothing new']]) } });
  job('fx-job-receipts', 'watson', 'Watson', 'Receipt matcher', { every: 'Every hour', lastRunAt: now - 40 * MIN, nextRunAt: now + 20 * MIN },
    'Matched 3 receipts; nothing for you.',
    { facts: { parentItemId: 'fx-watson-chat', runs: runs([[40 * MIN, 'ok', 'Matched 3'], [100 * MIN, 'quiet', 'Nothing new'], [160 * MIN, 'quiet', 'Nothing new']]) } });
  job('fx-job-prsweep', 'victor', 'Victor', 'PR sweep', { every: 'Every 15 min', lastRunAt: now - 6 * MIN, nextRunAt: now + 9 * MIN },
    'Merged two approved PRs; one waits on a reviewer.',
    { facts: { projectId: 'desk-reliability', parentItemId: 'fx-victor-merge', runs: runs([[6 * MIN, 'ok', 'Merged #371 and #374'], [21 * MIN, 'quiet', 'Nothing ready'], [36 * MIN, 'quiet', 'Nothing ready']]) } });
  job('fx-job-health', 'victor', 'Victor', 'Nightly health report', { every: 'Nightly 2:00', lastRunAt: now - 9 * HOUR, nextRunAt: now + 15 * HOUR },
    'The disk check timed out after 60 s; the report is incomplete.',
    { nextStep: 'failed', facts: { projectId: 'desk-reliability', parentItemId: 'fx-victor-merge', failed: { at: now - 9 * HOUR, reason: 'timeout', message: 'disk check timed out after 60 s' }, runs: runs([[9 * HOUR, 'failed', 'Disk check timed out'], [33 * HOUR, 'ok', 'All green'], [57 * HOUR, 'ok', 'All green']]) } });
  job('fx-job-closures', 'sierra', 'Sierra', 'Closure scan', { every: 'Mondays 7:00', lastRunAt: now - 4 * DAY, nextRunAt: now + 3 * DAY },
    'Two new seasonal closures added to the ride book.',
    { facts: { runs: runs([[4 * DAY, 'ok', '2 closures added'], [11 * DAY, 'quiet', 'Nothing new']]) } });

  const worker = (id, title, owner, extra = {}) =>
    add({
      id, source: 'loom', kind: 'loom', agentId: 'loom', agentName: 'Loom', place: `tango · ${title}`, area: 'Tango', nextStep: 'fyi', seen: 'seen',
      lastActivityAt: now - 4 * MIN, ...extra,
      facts: { role: 'worker', parentItemId: owner, ...(extra.facts || {}) },
    });
  worker('loom:fx-w-tests', 'Codex · empty-state tests', 'loom:fx-empty-state', {
    nextStep: 'working', lastActivityAt: now - 2 * MIN,
    summary: { title: 'Writing tests', gist: '9 of 14 tests written; running the suite.', step: 'fyi', options: [], context: [] },
    facts: { projectId: 'desk-reliability', running: { since: now - 12 * MIN } },
  });
  worker('loom:fx-w-a11y', 'Accessibility audit', 'loom:fx-empty-state', {
    nextStep: 'failed', lastActivityAt: now - 18 * MIN,
    summary: { title: 'Audit failed', gist: 'The contrast checker crashed on the dark theme. The empty-state thread is looking at it.', step: 'fyi', options: [], context: [] },
    facts: { projectId: 'desk-reliability', failed: { at: now - 18 * MIN, reason: 'crash', message: 'contrast checker crashed' } },
  });
  worker('loom:fx-w-export', 'Codex · CSV export fix', 'loom:fx-export-pr', {
    nextStep: 'working', lastActivityAt: now - 7 * MIN,
    summary: { title: 'Fixing the export', gist: 'Attempt 2 of 3: the date column now round-trips.', step: 'fyi', options: [], context: [] },
    facts: { projectId: 'billing', running: { since: now - 30 * MIN } },
  });
  add({
    id: 'fx-w-sierra-weights', agentId: 'sierra', agentName: 'Sierra', place: 'Research · trailer tongue weights', area: 'Trips', nextStep: 'fyi', seen: 'seen',
    lastActivityAt: now - 9 * MIN,
    summary: { title: 'Researching', gist: '14 listings checked; 3 match the hitch rating.', step: 'fyi', options: [], context: [] },
    facts: { role: 'worker', parentItemId: 'fx-sierra-loop', running: { since: now - 20 * MIN } },
  });

  // PR presentation cases: synthetic repositories and numbers only.
  const pr = (number, over = {}) => ({ url: `https://github.com/example/desk/pull/${number}`, repo: 'example/desk', number, title: 'Keep the thread panel readable', state: 'open', review: null, checks: 'passing', relation: 'opened', watched: true, firstSeenAt: now - DAY, checkedAt: now - 2 * MIN, ...over });
  const prCases = [
    [pr(101)],
    [pr(102, { watched: false })],
    [pr(103, { review: 'pending' }), pr(104, { state: 'merged', mergedAt: now - 2 * HOUR }), pr(105, { state: 'merged', relation: 'worker', via: { itemId: 'loom:fx-w-export', title: 'CSV export fix' }, mergedAt: now - HOUR })],
    [pr(106, { state: 'merged', mergedAt: now - HOUR })],
    [pr(107, { state: 'draft', checks: null })],
    [pr(108, { state: 'closed', closedAt: now - DAY })],
    [pr(109, { relation: 'mentioned', watched: false })],
    [pr(110, { checks: 'failing', error: 'GitHub read failed; showing the last known state' })],
    [pr(111), pr(112, { repo: 'example/widgets', url: 'https://github.com/example/widgets/pull/112', checks: 'running' })],
    Array.from({ length: 6 }, (_, i) => pr(113 + i, { state: i < 2 ? 'open' : i < 4 ? 'merged' : 'closed', review: i === 0 ? 'changes_requested' : null })),
  ];
  prCases.forEach((prs, i) => add({
    id: `loom:fx-pr-${i}`, source: 'loom', agentId: 'loom', agentName: 'Loom', area: 'tango',
    place: ['Watched change', 'Unwatched change', 'Thread and worker changes', 'Shipped change', 'Draft change', 'Closed change', 'Reference only', 'Last read failed', 'Two repositories', 'Six pull requests'][i],
    nextStep: 'fyi', seen: 'seen', lastActivityAt: now - (i + 1) * MIN,
    summary: { gist: 'Pull request fixture', step: 'fyi', options: [], context: [] },
    facts: { projectId: 'desk-reliability', lastAuthor: 'agent' }, prs,
    artifacts: prs.map(p => ({ kind: 'pr', url: p.url, label: p.title })),
  }));

  // Crowded metadata must yield to both single and multi-PR chips.
  [1, 3].forEach((count) => add({
    id: `loom:fx-pr-crowded-${count}`, source: 'loom', agentId: 'loom', agentName: 'Loom', area: 'tango',
    place: `Crowded metadata with ${count} open pull requests`,
    nextStep: 'fyi', seen: 'seen', lastActivityAt: now,
    summary: { gist: 'Long review and waiting facts beside a pull request chip.', step: 'fyi', options: [], context: [] },
    facts: { projectId: 'desk-reliability', lastAuthor: 'agent', prChecks: { state: 'failing' },
      inFlight: [{ kind: 'wait', text: 'PR #119 review and required checks before the next integration build can proceed' }] },
    watching: { reason: 'pr review', waitingOn: { who: 'Reviewer', what: 'PR #119 review and required checks before integration', since: now - HOUR } },
    prs: Array.from({ length: count }, (_, i) => pr(119 + i)),
  }));

  const scenes = {
    'scn-sierra-map': { id: 'scn-sierra-map', agentId: 'sierra', agentName: 'Sierra', color: '#e5b93b', accent: '#e5b93b', kind: 'html', title: 'Ridge Loop loop: closures and reroute', summary: 'Closures and a reroute', version: 1, updatedAt: now - 2 * DAY, conversationKey: 'thread:fx-sierra-loop', itemId: 'fx-sierra-loop' },
    'scn-sierra-ride': { id: 'scn-sierra-ride', agentId: 'sierra', agentName: 'Sierra', color: '#e5b93b', accent: '#3ecf8e', kind: 'html', title: 'Ride book p.14', summary: 'Ride book page', version: 1, updatedAt: now - 3 * DAY, conversationKey: 'thread:fx-sierra-loop', itemId: 'fx-sierra-loop' },
    'scn-victor-diff': { id: 'scn-victor-diff', agentId: 'victor', agentName: 'Victor', color: '#b07cf0', accent: '#b07cf0', kind: 'html', layout: 'diff', title: 'PR #372 diff', summary: 'The reconnect diff', version: 1, updatedAt: now - 3 * MIN, conversationKey: 'thread:fx-victor-merge', itemId: 'fx-victor-merge' },
  };

  return { items, messages, timelines, scenes };
}

export function createFixtureClient({ params = new URLSearchParams(location.search) } = {}) {
  const now = Date.now();
  const db = seed(now);
  const listeners = new Set();
  const commands = new Map();
  // ?fail=: these fail once each (the next try goes through), so a Retry can be seen working.
  const failing = new Set((params.get('fail') || '').split(',').map((t) => t.trim()).filter(Boolean));
  const ledger = createSystemFixture(Date.now(), { clear: params.get('system') === 'clear' });
  let seq = 100;
  const events = [
    { seq: 97, at: now - 50 * MIN, itemId: 'fx-ch-breakfast', type: 'done', actor: 'system', payload: { reason: 'chapter.settled' }, undoable: true },
    { seq: 98, at: now - 30 * MIN, itemId: 'fx-deck-quote', type: 'snooze.expired', actor: 'system', payload: { trigger: 'time' }, undoable: false },
    { seq: 99, at: now - 9 * MIN, itemId: 'loom:fx-empty-state', type: 'seen', actor: 'screen', payload: { via: 'viewed', ms: 4200 }, undoable: true },
  ];
  const snapshots = new Map(); // seq -> attention snapshot before the event (for undo)
  // Invented projects, each holding a few of the fixture conversations (`?projects=0`: none).
  const fixtureProjects = params.get('projects') === '0' ? [] : [
    { id: 'desk-reliability', name: 'Desk reliability', icon: 'layout-dashboard', color: 'violet', about: 'The desk stays up and says what is true.', createdAt: now - 20 * DAY },
    { id: 'billing', name: 'Billing', icon: 'receipt', color: 'amber', createdAt: now - 9 * DAY },
    { id: 'house', name: 'House projects', icon: 'house', color: 'emerald', createdAt: now - 30 * DAY },
  ];
  const inProject = { 'loom:fx-empty-state': 'desk-reliability', 'loom:fx-migrate': 'desk-reliability', 'loom:fx-health': 'desk-reliability', 'loom:fx-voice': 'desk-reliability', 'fx-victor-merge': 'desk-reliability', 'fx-victor-feedback': 'desk-reliability', 'loom:fx-webhooks': 'billing', 'loom:fx-export-pr': 'billing', 'fx-deck-quote': 'house', 'fx-juliet-tiles': 'house' };
  // `?always=active,snoozed`: Ready is the first tab and always shows projects in those states, with a snoozed and a parked project to find.
  const always = params.get('always');
  if (always != null && fixtureProjects.length) {
    fixtureProjects.push(
      { id: 'trip', name: 'Off-road trip', icon: 'mountain', color: 'sky', createdAt: now - 12 * DAY, away: { state: 'snoozed', at: now - 2 * HOUR, until: now + 20 * HOUR } },
      { id: 'taxes', name: 'Taxes 2025', icon: 'wallet', color: 'rose', createdAt: now - 40 * DAY, away: { state: 'parked', at: now - 5 * MIN } },
    );
    Object.assign(inProject, { 'fx-sierra-loop': 'trip', 'fx-juliet-ferry': 'trip', 'fx-watson-receipts': 'taxes' });
  }
  // `?nest=1`: projects inside projects and an agent (two levels), with threads at both levels.
  if (params.get('nest') === '1' && fixtureProjects.length) {
    fixtureProjects.splice(0, fixtureProjects.length,
      { id: 'tango', name: 'Tango', icon: 'sparkles', color: 'teal', about: 'The agent system: Desk, Voice and Loom, and the work between them.', createdAt: now - 60 * DAY },
      { id: 'desk-reliability', name: 'Desk', icon: 'layout-dashboard', color: 'violet', about: 'The desk stays up and says what is true.', createdAt: now - 20 * DAY, parent: 'project:tango' },
      { id: 'voice', name: 'Voice', icon: 'mic', color: 'lime', createdAt: now - 18 * DAY, parent: 'project:tango' },
      { id: 'loom', name: 'Loom', icon: 'spool', color: 'orange', createdAt: now - 10 * DAY, parent: 'project:tango' },
      { id: 'bike', name: 'Bike', icon: 'car', color: 'amber', about: 'The Bike: brakes, the oil change and the quote.', createdAt: now - 8 * DAY, parent: 'agent:sierra' },
      { id: 'billing', name: 'Billing', icon: 'receipt', color: 'amber', createdAt: now - 9 * DAY },
      { id: 'house', name: 'House projects', icon: 'house', color: 'emerald', createdAt: now - 30 * DAY },
    );
    Object.assign(inProject, { 'fx-victor-merge': 'tango', 'fx-victor-feedback': 'tango', 'loom:fx-voice': 'voice', 'loom:fx-health': 'loom', 'fx-sierra-loop': 'bike', 'fx-w-sierra-weights': 'bike' });
  }
  if (fixtureProjects.length) for (const item of db.items) if (inProject[item.id]) item.facts = { ...(item.facts || {}), projectId: inProject[item.id] };
  let settings = {
    sweepDay: 'saturday', filters: normalizeFilters(null), projects: fixtureProjects,
    // A space's own record (docs/specs/spaces.md): an agent's About, set in its Space settings.
    spaces: {
      'agent:watson': { about: 'Chief of staff: email, calendar, receipts and the morning brief.', stands: 'Receipts are 29 of 41 matched; two renewals wait until you’re at your desk.', standsAt: now - 35 * MIN },
      'agent:victor': { about: 'Keeps the desk and the bot running: PRs, health checks, deploys.', stands: 'The reconnect fix is ready to merge; last night’s health report failed on the disk check.', standsAt: now - 20 * MIN },
      'agent:sierra': { about: 'Trips, routes and research; plans the rides and checks the closures.', stands: 'The coast loop waits on your reroute call; trailer research is running.', standsAt: now - 2 * HOUR },
      'agent:malibu': { about: 'Training and food: plans the week and logs what you eat.' },
      'agent:juliet': { about: 'House and errands: quotes, bookings and the to-do list.' },
      'agent:foxtrot': { about: 'Money: tides of the budget, bills and transfers.' },
    },
  };
  if (always != null) {
    const showProjects = always.split(',').filter(Boolean);
    const ready = DEFAULT_VIEWS.find((v) => v.id === 'ready');
    settings.listViews = [{ ...ready, showProjects: showProjects.length ? showProjects : undefined }, ...DEFAULT_VIEWS.filter((v) => v !== ready)];
  }
  const filtered = (i) => filterMatches(i, settings.filters).length > 0;

  if (params.get('clear') === '1') {
    db.items
      .filter((i) => i.disposition === 'active')
      .forEach((i, n) => Object.assign(i, { disposition: 'done', doneAt: Math.max(todayAt(now, 0, 5), now - (n + 1) * 23 * MIN), seen: 'seen' }));
  }

  // One invented prototype, on the Victor merge thread (the Prototype view).
  const fixturePrototypes = [
    { id: 'pfx-onboarding', agentId: 'loom', agentName: 'Loom · tango', conversationKey: 'thread:fx-victor-merge', name: 'main', title: 'Onboarding flow v2', url: 'fixture:onboarding', drivable: true, version: 1, updatedAt: now - 20 * 60_000 },
  ];
  const prototypesIn = (key) => fixturePrototypes.filter((p) => p.conversationKey === key);
  const startView = params.get('view');
  const startItem = params.get('item');
  const startScene = startView === 'screen' ? Object.values(db.scenes).find((s) => !startItem || s.itemId === startItem) : null;
  let presentation = {
    view: ['conversation', 'screen', 'prototype'].includes(startView) ? startView : 'active',
    itemId: startScene?.itemId || startItem || (startView ? 'fx-victor-merge' : null),
    conversationKey: null,
    sceneId: startScene?.id || null,
    queue: ['scn-victor-diff'],
    queueScenes: [{ sceneId: 'scn-victor-diff', agentId: 'victor', agentName: 'Victor', title: 'PR #372 diff', conversationKey: 'thread:fx-victor-merge' }],
    by: 'director',
    since: now,
  };
  presentation.upNext = presentation.queueScenes[0];
  if (presentation.itemId) presentation.conversationKey = find(presentation.itemId)?.conversationKey || null;
  if (presentation.view === 'active') presentation.itemId = null;
  presentation.prototypes = presentation.conversationKey ? prototypesIn(presentation.conversationKey) : [];
  presentation.prototype = presentation.view === 'prototype' ? presentation.prototypes[0] || null : null;
  presentation.prototypeId = presentation.prototype?.id || null;

  const operatorPin = params.get('operator');
  let operator = { live: operatorPin === 'live', status: operatorPin === 'live' ? 'listening' : 'idle', agentName: null, transcript: null };

  // Draft mode: an invented draft in the state ?draft= asks for.
  const DRAFT_FIXTURES = {
    listening: { active: true, status: 'listening', target: { agentId: 'sierra', name: 'Sierra', where: null, label: 'Sierra' }, fragments: ['So for the coast trip, um, I think we leave Friday after lunch,', 'and we should take the small tent, not the big one, because the site is tiny', 'oh and check whether the ferry runs on Saturdays in October'], compiled: null, question: null, note: null },
    confirm: { active: true, status: 'confirm', target: { agentId: 'sierra', name: 'Sierra', where: 'Ridge Loop loop', label: 'Sierra · Ridge Loop loop thread' }, fragments: ['So for the coast trip, um, I think we leave Friday after lunch,', 'and we should take the small tent, not the big one, because the site is tiny', 'oh and check whether the ferry runs on Saturdays in October'], compiled: 'For the coast trip: we leave Friday after lunch. Take the small tent, not the big one; the site is tiny. Can you check whether the ferry runs on Saturdays in October?', question: null, note: null },
    question: { active: true, status: 'confirm', target: { agentId: 'sierra', name: 'Sierra', where: null, label: 'Sierra · main channel' }, fragments: ['move the review to Thursday'], compiled: 'Move the review to Thursday.', question: 'Is that this Thursday or next?', note: null },
  };
  let fixtureRouting = { default: ['claude_home'], repos: [{ repo: 'acme', accounts: ['claude_team', 'claude_spare'] }, { repo: 'tango', accounts: ['claude_home'] }], error: null };
  let draft = DRAFT_FIXTURES[params.get('draft')] ? { ...DRAFT_FIXTURES[params.get('draft')], id: 'fixture-draft', updatedAt: Date.now() } : null;

  // Pause mode: the operator paused, holding ?waiting= updates (default 3).
  const pauseParam = params.get('pause');
  let pause = pauseParam
    ? { id: 'fixture-pause', active: true, since: Date.now() - (pauseParam === 'still' ? 34 : 4) * MIN, waiting: Number(params.get('waiting') ?? 3) || 0, still: pauseParam === 'still', updatedAt: Date.now() }
    : null;

  function find(id) {
    return db.items.find((i) => i.id === id);
  }
  function emit(name, data) {
    for (const h of listeners) h[name]?.(clone(data));
  }
  function touch(item, at = Date.now()) {
    item.revision += 1;
    item.updatedAt = at;
    emit('onItem', { id: item.id, revision: item.revision });
  }
  function attention(item) {
    // `_pickedUpAt` too: undoing Back to Active on its own puts it back under its project (Codex review on #537).
    return { disposition: item.disposition, seen: item.seen, snoozeUntil: item.snoozeUntil, snoozeTrigger: item.snoozeTrigger, backFromSnooze: item.backFromSnooze, doneAt: item.doneAt, _pickedUpAt: item._pickedUpAt };
  }
  function logEvent(item, type, actor, payload = {}, undoable = true) {
    const event = { seq: ++seq, at: Date.now(), itemId: item.id, type, actor, payload, undoable };
    events.unshift(event);
    if (undoable) snapshots.set(event.seq, { itemId: item.id, before: attention(item) });
    emit('onActivity', event);
    return event;
  }
  /**
   * An item as every reader sees it, as the desk does (core.withProjectHold): held by its project while
   * the project is snoozed or parked, its own state kept underneath (Codex review on #537).
   */
  function shown(item) {
    // Its own project's snooze or park, else its parent project's (core.withProjectHold, projects.ts holderOf).
    const own = (settings.projects || []).find((p) => p.id === item.facts?.projectId && !p.finishedAt);
    const up = own?.parent?.startsWith('project:') ? (settings.projects || []).find((p) => p.id === own.parent.slice(8) && !p.finishedAt) : null;
    const holder = own?.away ? own : up?.away ? up : null;
    const away = holder?.away;
    if (!away || item.disposition !== 'active') return item;
    if (away.state === 'snoozed' && away.until != null && away.until <= Date.now()) return item;
    if ((item._pickedUpAt ?? -1) >= away.at || (item.lastOwnerMessageAt ?? 0) > away.at) return item;
    if ((away.state === 'parked' || away.trigger === 'agent_posts') && item.facts?.lastAuthor === 'agent' && item.lastActivityAt > away.at) return item;
    return { ...item, disposition: away.state, snoozeUntil: away.until ?? null, snoozeTrigger: away.trigger ?? null, heldBy: holder.id };
  }
  function publicItem(item) {
    const copy = clone(shown(item));
    for (const key of Object.keys(copy)) if (key.startsWith('_')) delete copy[key];
    return copy;
  }
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  function counts() {
    const open = db.items.map(shown).filter((i) => i.disposition === 'active' && !i.hidden);
    const active = open.filter((i) => !filtered(i));
    return {
      active: active.length,
      filtered: open.length - active.length,
      new: active.filter((i) => i.seen === 'new').length,
      updated: active.filter((i) => i.seen === 'updated').length,
      yourMove: active.filter((i) => i.nextStep === 'your_move' || i.nextStep === 'failed').length,
      snoozed: db.items.map(shown).filter((i) => i.disposition === 'snoozed').length,
      parked: db.items.map(shown).filter((i) => i.disposition === 'parked').length,
      done: db.items.filter((i) => i.disposition === 'done').length,
    };
  }

  // ── command handling (mirrors the spec's reducer, loosely) ─────────
  function agentReplies(item, text) {
    setTimeout(() => {
      if (item.disposition !== 'active') return;
      item.nextStep = 'fyi';
      item.seen = 'updated';
      item.activity = null;
      item.lastActivityAt = Date.now();
      item.summary = { ...item.summary, gist: `On it: “${text}”. Done, and I’ll post here if anything changes.`, ask: null, options: [], context: [], step: 'fyi' };
      db.messages[item.id].push({ messageId: `${item.id}-r${Date.now()}`, author: 'agent', at: Date.now(), text: `Done: ${text}` });
      db.timelines[item.id].push({ at: Date.now(), kind: 'ok', text: 'Handled your reply' });
      touch(item);
    }, 9000);
  }

  function apply(cmd) {
    const item = cmd.itemId ? find(cmd.itemId) : null;
    const args = cmd.args || {};
    const at = Date.now();
    if (cmd.type !== 'undo' && !item) return { status: 'failed', error: 'unknown item' };
    switch (cmd.type) {
      case 'unseen': {
        if (item.seen !== 'seen') return { status: 'applied', outcome: { changed: false } };
        const e = logEvent(item, 'unseen', 'screen', {});
        item.seen = 'new';
        touch(item, at);
        return { status: 'applied', outcome: { seq: e.seq } };
      }
      case 'seen':
      case 'viewed': {
        if (cmd.type === 'viewed' && (args.ms || 0) < 3000) return { status: 'applied', outcome: { changed: false } };
        if (item.seen === 'seen') return { status: 'applied', outcome: { changed: false } };
        const e = logEvent(item, 'seen', 'screen', { via: cmd.type, ms: args.ms });
        item.seen = 'seen';
        item.backFromSnooze = false;
        touch(item, at);
        return { status: 'applied', outcome: { seq: e.seq } };
      }
      case 'done': {
        const job = item.facts?.job;
        if (job && typeof args.stopJob !== 'boolean') return { status: 'failed', error: `stopJob is required: "${job.label}" is still running in this conversation` };
        const e = logEvent(item, 'done', 'screen', { stopJob: args.stopJob });
        if (job && args.stopJob) job.status = 'stopped';
        item.disposition = 'done';
        item.doneAt = at;
        if (item._writebackFailsOnce) {
          delete item._writebackFailsOnce;
          item.writeback = { action: 'done', outcome: 'failed', error: 'thread.settle failed: Loom did not answer (fixture)', at };
        } else {
          item.writeback = { action: 'done', outcome: item.source === 'loom' || item.kind === 'thread' ? 'ok' : 'n/a', at };
        }
        touch(item, at);
        return { status: 'applied', outcome: { seq: e.seq, writeback: item.writeback } };
      }
      case 'reopen':
      case 'pickup': {
        const e = logEvent(item, cmd.type, 'screen');
        item.disposition = 'active';
        item.seen = 'new';
        item.snoozeUntil = null;
        item.snoozeTrigger = null;
        // Held by its project: this one comes back on its own; the project stays away.
        if (shown(item).heldBy) item._pickedUpAt = Date.now();
        touch(item, at);
        return { status: 'applied', outcome: { seq: e.seq } };
      }
      case 'snooze': {
        if (args.onlyIfActive && item.disposition !== 'active') return { status: 'failed', error: 'already out of the rotation', outcome: { active: false } };
        if (args.onlyIfSnoozed && item.disposition !== 'snoozed') return { status: 'failed', error: 'no longer snoozed', outcome: { snoozed: false } };
        if (args.onlyIfSnoozed && typeof args.snoozeSeq === 'number' && item.snoozeSeq !== args.snoozeSeq) return { status: 'failed', error: 'a newer snooze is in effect', outcome: { snoozed: true, replaced: true } };
        const e = logEvent(item, 'snooze', 'screen', args);
        item.disposition = 'snoozed';
        item.snoozeUntil = args.until || null;
        item.snoozeTrigger = args.trigger || null;
        item.snoozeSeq = e.seq;
        touch(item, at);
        return { status: 'applied', outcome: { seq: e.seq } };
      }
      case 'tag': {
        // As the desk does it: stage and type kept on the item, never in a title.
        const facts = { ...(item.facts || {}) };
        const toFeedback = cmd.args?.stage === 'feedback' && item.facts?.stage !== 'feedback' && (item.disposition ?? 'active') === 'active';
        if (cmd.args && 'stage' in cmd.args) facts.stage = cmd.args.stage || null;
        if (cmd.args && 'type' in cmd.args) facts.type = cmd.args.type || null;
        item.facts = facts;
        // As the desk does it: the owner moving Active work to Feedback parks it (undoable).
        const parked = toFeedback ? logEvent(item, 'park', 'screen', { via: 'feedback' }) : null;
        if (parked) item.disposition = 'parked';
        touch(item, at);
        return { status: 'applied', outcome: { stage: facts.stage ?? null, type: facts.type ?? null, ...(parked ? { parked: true, seq: parked.seq } : {}) } };
      }
      case 'project': {
        // As the desk does it: kept on the item, any source.
        const projectId = cmd.args?.projectId || null;
        if (projectId && !(settings.projects || []).some((p) => p.id === projectId)) return { status: 'failed', error: `no project ${projectId}` };
        item.facts = { ...(item.facts || {}), projectId };
        touch(item, at);
        return { status: 'applied', outcome: { projectId } };
      }
      case 'label': {
        // As the desk does it: a Loom thread's title prefix, else a desk-side label.
        const label = cmd.args?.label || null;
        if (item.source === 'loom') {
          const [where, ...rest] = String(item.place || '').split(' · ');
          const title = rest.join(' · ').replace(/^(epic|disc|bug|feat|enh|chore|ops|skill|watch|hold):\s*/i, '');
          item.place = `${where} · ${label ? `${label}: ` : ''}${title}`;
        } else {
          item.facts = { ...(item.facts || {}), listLabel: label };
        }
        touch(item, at);
        return { status: 'applied', outcome: { label, at: item.source === 'loom' ? 'source' : 'desk' } };
      }
      case 'pin': {
        // As the desk does it: Loom keeps a Loom thread's pin, the desk keeps anything else's.
        if (typeof cmd.args?.pinned !== 'boolean') return { status: 'failed', error: 'pinned must be true or false' };
        item.facts = { ...(item.facts || {}), pinned: cmd.args.pinned };
        // A pin is a promotion: back to Active from History, Snoozed or Parked.
        if (cmd.args.pinned && item.disposition !== 'active') {
          logEvent(item, 'pickup', 'screen');
          item.disposition = 'active';
          item.snoozeUntil = null;
          item.doneAt = null;
        }
        touch(item, at);
        return { status: 'applied', outcome: { pinned: cmd.args.pinned, at: item.source === 'loom' ? 'source' : 'desk' } };
      }
      case 'space': {
        const agent = cmd.args?.agent ?? null;
        item.facts = { ...(item.facts || {}), agentSpace: agent ? { id: String(agent.id).toLowerCase(), name: String(agent.name) } : null };
        touch(item, at);
        return { status: 'applied', outcome: { agentSpace: item.facts.agentSpace } };
      }
      case 'role': {
        // As the desk does it (roles.ts): the conversation's kind and what it reports to.
        const role = cmd.args?.role;
        if (!['interactive', 'worker', 'ops', 'default'].includes(role)) return { status: 'failed', error: 'role must be interactive, worker, ops or default' };
        item.facts = { ...(item.facts || {}), role, ...(cmd.args.parentItemId !== undefined ? { parentItemId: cmd.args.parentItemId } : {}) };
        touch(item, at);
        return { status: 'applied', outcome: { role } };
      }
      case 'rename': {
        // As the desk does it: Loom keeps a Loom thread's title (it needs one), the desk keeps anything else's name.
        const title = String(cmd.args?.title ?? '').replace(/\s+/g, ' ').trim();
        if (item.source === 'loom') {
          if (!title) return { status: 'failed', error: 'a Loom thread needs a title' };
          item.place = `${String(item.place || '').split(' · ')[0]} · ${title}`;
        } else item.facts = { ...(item.facts || {}), name: title || null };
        touch(item, at);
        return { status: 'applied', outcome: { title: title || null, at: item.source === 'loom' ? 'source' : 'desk' } };
      }
      case 'raise': {
        // As the desk does it: +50% of the thread's budget for today.
        const budget = item.facts?.budget;
        if (item.source !== 'loom' || !budget?.base) return { status: 'failed', error: 'this thread has no budget to raise' };
        const raised = budget.raised + Math.round(budget.base * 0.5);
        const limit = budget.base + raised;
        item.facts = { ...item.facts, budget: { ...budget, raised, limit, share: budget.today / limit }, held: item.facts.held?.reason === 'budget' ? null : item.facts.held };
        touch(item, at);
        return { status: 'applied', outcome: { budget: item.facts.budget } };
      }
      case 'keep':
      case 'fresh': {
        // As the desk does it: only a Loom thread keeps or restarts its session.
        if (item.source !== 'loom') return { status: 'failed', error: 'only a Loom thread’s session can be kept or started fresh' };
        if (cmd.type === 'fresh') return { status: 'applied', outcome: { fresh: true } };
        const keepSession = cmd.args?.keep !== false;
        item.facts = { ...item.facts, keepSession };
        touch(item, at);
        return { status: 'applied', outcome: { keepSession } };
      }
      case 'run':
      case 'pause': {
        // As the desk does it: only a Tango schedule takes Run now and Pause; the run itself lands later.
        if (item.source !== 'schedule') return { status: 'failed', error: `only a job can be ${cmd.type === 'run' ? 'run' : 'paused'} from the desk` };
        if (cmd.type === 'run') return { status: 'applied', outcome: { started: true } };
        const paused = cmd.args?.paused !== false;
        item.facts = { ...item.facts, schedule: { ...(item.facts.schedule || {}), paused } };
        touch(item, at);
        return { status: 'applied', outcome: { paused } };
      }
      case 'watch': {
        // As the desk does it: the PR's review is read on the next GitHub poll (not simulated here).
        const url = String(cmd.args?.url || '');
        const m = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/i.exec(url);
        if (!m) return { status: 'failed', error: 'url must be a GitHub pull request link' };
        const canonical = `https://github.com/${m[1]}/${m[2]}/pull/${Number(m[3])}`;
        const others = (item.facts?.prWatches || []).filter((w) => w.url.toLowerCase() !== canonical.toLowerCase());
        const prWatches = cmd.args?.off ? others : [...others, { url: canonical, number: Number(m[3]), onApprove: 'continue', at, by: 'screen' }];
        const stage = item.facts?.stage ?? null;
        const toFeedback = !cmd.args?.off && (stage === null || stage === 'discovery' || stage === 'building');
        item.facts = { ...(item.facts || {}), prWatches: prWatches.length ? prWatches : null, ...(toFeedback ? { stage: 'feedback' } : {}) };
        touch(item, at);
        return { status: 'applied', outcome: { watching: !cmd.args?.off, url: canonical } };
      }
      case 'park': {
        const e = logEvent(item, 'park', 'screen');
        item.disposition = 'parked';
        touch(item, at);
        return { status: 'applied', outcome: { seq: e.seq } };
      }
      case 'reply':
      case 'answer': {
        const text = cmd.type === 'answer' ? args.option : args.text;
        const images = cmd.type === 'reply' && Array.isArray(args.attachments) ? args.attachments.map((a) => ({ name: a.name, mimeType: a.mimeType, url: a.dataUrl })) : [];
        if (!text && !images.length) return { status: 'failed', error: 'empty reply' };
        if (item._replyFailsOnce) {
          delete item._replyFailsOnce;
          return { status: 'failed', error: 'Discord rejected the message (simulated source failure)' };
        }
        db.messages[item.id].push({ messageId: `${item.id}-o${at}`, author: 'owner', at, text: text || '', ...(images.length ? { attachments: images } : {}) });
        db.timelines[item.id].push({ at, kind: 'owner', text: `You: “${text}”` });
        item.nextStep = 'working';
        item.seen = 'seen';
        item.lastOwnerMessageAt = at;
        item.lastActivityAt = at;
        item.summary = { ...item.summary, ownerAsk: text };
        item.activity = { text: 'Reading your reply', at, lines: [] };
        touch(item, at);
        agentReplies(item, text);
        return { status: 'applied', outcome: { messageId: `${item.id}-o${at}` } };
      }
      case 'respond':
      case 'approve':
      case 'dismiss': {
        const pending = item.facts?.pending;
        if (!pending) return { status: 'failed', error: 'the question changed: nothing is pending on this item any more', outcome: { changed: true } };
        if (args.requestId && args.requestId !== pending.requestId) return { status: 'failed', error: 'the question changed since you saw it', outcome: { changed: true } };
        if (item._respondFailsOnce) {
          delete item._respondFailsOnce;
          return { status: 'failed', error: 'answer not delivered: Loom did not answer (fixture)' };
        }
        if (cmd.type === 'respond') {
          const missing = pending.questions.find((q) => !args.answers || args.answers[q.id] == null || args.answers[q.id] === '');
          if (missing) return { status: 'failed', error: `no answer for "${missing.header || missing.question}"` };
        }
        const said =
          cmd.type === 'respond'
            ? pending.questions.map((q) => `${q.header || 'Answer'}: ${[].concat(args.answers[q.id]).join(', ')}`).join(' · ')
            : cmd.type === 'approve'
              ? `Approval: ${pending.approval.options.find((o) => o.decision === args.decision)?.label || args.decision}`
              : 'Dismissed the question';
        item.facts = { ...item.facts, pending: null };
        item.ask = null;
        item.options = [];
        db.timelines[item.id].push({ at, kind: 'owner', text: `You: ${said}` });
        item.nextStep = 'working';
        item.seen = 'seen';
        item.lastOwnerMessageAt = at;
        item.lastActivityAt = at;
        item.activity = { text: 'Continuing with your answer', at, lines: [] };
        touch(item, at);
        agentReplies(item, said);
        return { status: 'applied', outcome: { delivered: true, requestId: pending.requestId } };
      }
      case 'retry': {
        item.nextStep = 'working';
        item.facts = { ...item.facts, failed: null };
        item.activity = { text: 'Retrying the last request', at, lines: [] };
        item.lastActivityAt = at;
        db.timelines[item.id].push({ at, kind: 'agent', text: 'Retried' });
        touch(item, at);
        agentReplies(item, item.summary?.ownerAsk || 'retry');
        return { status: 'applied', outcome: {} };
      }
      case 'undo': {
        const snap = snapshots.get(args.seq);
        if (!snap) return { status: 'failed', error: 'that can no longer be undone' };
        const target = find(snap.itemId);
        Object.assign(target, snap.before);
        snapshots.delete(args.seq);
        const original = events.find((e) => e.seq === args.seq);
        if (original) original.undoable = false;
        const e = { seq: ++seq, at, itemId: target.id, type: 'undo', actor: 'screen', payload: { seq: args.seq, undid: original?.type }, undoable: false };
        events.unshift(e);
        emit('onActivity', e);
        touch(target, at);
        return { status: 'applied', outcome: { seq: e.seq } };
      }
      case 'sweep': {
        const keep = args.decision === 'keep';
        const e = logEvent(item, keep ? 'sweep.keep' : 'sweep.drop', 'screen');
        item.disposition = keep ? 'active' : 'done';
        item.seen = keep ? 'new' : item.seen;
        if (!keep) item.doneAt = at;
        item._swept = true;
        touch(item, at);
        return { status: 'applied', outcome: { seq: e.seq } };
      }
      default:
        return { status: 'failed', error: `unknown command ${cmd.type}` };
    }
  }

  // ── timed updates ──────────────────────────────────────────────────
  const timers = [];
  if (params.get('quiet') !== '1') {
    const receipts = find('fx-watson-receipts');
    const steps = [
      'Matched Costco 9/14 → statement line 37',
      'Reading receipts/2026-09/hardware-store.pdf',
      '30 of 41 matched · 2 flagged so far',
      'Matched fuel 9/18 → statement line 41',
      'Reading receipts/2026-09/pharmacy.jpg',
      '31 of 41 matched · 3 flagged so far',
    ];
    let step = 0;
    timers.push(
      setInterval(() => {
        if (receipts.nextStep !== 'working') return;
        receipts.activity = { text: steps[step % steps.length], at: Date.now(), lines: [] };
        receipts.summary.gist = steps.filter((s) => / of 41/.test(s))[Math.floor(step / 3) % 2];
        step += 1;
        touch(receipts);
      }, 4000),
    );
    // A new FYI lands a little after load, once.
    timers.push(
      setTimeout(() => {
        add({
          id: 'fx-papa-print',
          agentId: 'papa',
          agentName: 'Papa',
          place: 'Print run',
          area: 'Home',
          nextStep: 'fyi',
          seen: 'new',
          lastActivityAt: Date.now(),
          summary: { title: 'Flyers printed', gist: 'The flyer print run finished: 120 copies, ready at the shop after 4 pm.', step: 'fyi', options: [], context: [] },
        });
      }, 25000),
    );
    if (!operatorPin) {
      // The operator wakes up, hears a request, answers, and goes idle again.
      const script = [
        { live: false, status: 'idle' },
        { live: true, status: 'listening', transcript: { speaker: 'owner', text: '…tell Victor', final: false } },
        { live: true, status: 'listening', transcript: { speaker: 'owner', text: '…tell Victor to merge it tonight', final: true } },
        { live: true, status: 'speaking', agentName: 'Victor', transcript: { speaker: 'agent', name: 'Victor', text: 'Got it, I’ll merge at 11 and restart after the queue drains.', final: true } },
        { live: true, status: 'listening' },
      ];
      let i = 0;
      timers.push(
        setInterval(() => {
          i = (i + 1) % (script.length + 3);
          const next = script[Math.min(i, script.length - 1)] || script[0];
          operator = { ...operator, ...next, transcript: next.transcript || null, live: i < script.length ? next.live : false, status: i < script.length ? next.status : 'idle' };
          emit('onOperator', operator);
        }, 5000),
      );
    }
  }
  function add(item) {
    const full = {
      source: 'discord',
      kind: 'thread',
      labels: [],
      hidden: false,
      revision: 1,
      disposition: 'active',
      snoozeUntil: null,
      snoozeTrigger: null,
      backFromSnooze: false,
      doneAt: null,
      writeback: null,
      artifacts: [],
      activity: null,
      watching: null,
      facts: {},
      messageCount: 1,
      conversationKey: `thread:${item.id}`,
      updatedAt: item.lastActivityAt,
      ...item,
    };
    db.items.push(full);
    db.messages[full.id] = [{ messageId: `${full.id}-0`, author: 'agent', at: full.lastActivityAt, text: full.summary.gist }];
    db.timelines[full.id] = [{ at: full.lastActivityAt, kind: 'agent', text: full.summary.gist }];
    emit('onItem', { id: full.id, revision: 1 });
  }

  // ── project coordinators: Desk reliability's keeps watch and has answered once, with a drafted question ──
  const coord = {};
  const coordSummary = (projectId) => {
    const c = coord[projectId];
    if (!c) return null;
    return { projectId, exists: !!c.threadId, watch: { ...c.watch }, reach: c.reach, status: c.watch.on && c.watch.stands ? c.status : null, flags: c.watch.on && c.watch.flags ? c.flags : [], drafts: c.drafts.filter((d) => d.state === 'draft').length };
  };
  const coordTouch = (projectId) => emit('onCoordinator', coordSummary(projectId));
  const CANNED = [
    'Two things are on you and one is broken:\n\n- **Merge timing for the reconnect fix.** [operator-dependability](desk:fx-victor-merge) has PR #372 green and reviewed, and asks whether to deploy now or in tonight’s quiet window.\n- **Migration approval.** [Desk storage migration](desk:loom:fx-migrate) has a clean dry run and only needs your go.\n- **Health-check tuning failed.** [Health-check tuning](desk:loom:fx-health) errored mid-edit and hasn’t retried.\n\nI drafted a question for Health-check tuning about the failure.',
    'Since yesterday: [Inbox empty state](desk:loom:fx-empty-state) started the variants you asked for, and [Health-check tuning](desk:loom:fx-health) failed (new). Nothing finished.',
    'Yes, two decisions: [Desk storage migration](desk:loom:fx-migrate) (approve the migration) and [operator-dependability](desk:fx-victor-merge) (deploy now or tonight).',
  ];
  if (params.get('coordinator') !== '0' && fixtureProjects.some((p) => p.id === 'desk-reliability')) {
    coord['desk-reliability'] = {
      threadId: 'fx-coord',
      watch: { on: true, stands: true, flags: true, digest: true },
      reach: 'approve',
      status: { text: 'The reconnect fix (PR #372) is ready to deploy and waits on your timing call. The storage migration has waited on you two days. Health-check tuning failed and needs a retry. Inbox empty state and the reconnect feedback watch are on track.', line: 'Reconnect fix ready to deploy; the migration has waited on you 2 days; health-check tuning failed.', at: now - 12 * MIN, source: 'model' },
      flags: [{ itemId: 'loom:fx-migrate', title: 'Desk storage migration', kind: 'stalled', text: 'has waited on you 2 days' }],
      messages: [
        { id: 'fxq1', kind: 'question', text: 'What’s blocking this project?', at: now - 40 * MIN },
        { id: 'fxa1', kind: 'answer', text: CANNED[0], at: now - 39 * MIN },
      ],
      drafts: [{ id: 'fxd1', toItemId: 'loom:fx-health', toTitle: 'Health-check tuning', text: 'The last turn stopped mid-edit of health-check.ts. Can you retry, and tell me whether the 90s threshold still makes sense?', state: 'draft', createdAt: now - 39 * MIN }],
      digests: [{ at: now - 3 * HOUR, text: '- [Reconnect fix · feedback](desk:fx-victor-feedback): 3 reports overnight, none about voice dropping.\n- Still on you: [Desk storage migration](desk:loom:fx-migrate).' }],
      running: false,
      asked: 0,
    };
  }
  const coordFor = (projectId) =>
    (coord[projectId] ||= { threadId: null, watch: { on: false, stands: true, flags: true, digest: false }, reach: 'approve', status: null, flags: [], messages: [], drafts: [], digests: [], running: false, asked: 0 });

  // What agents decided (desk/decided.ts), for Undo and "I wouldn't have": two level 4 logs and a level 3 default, invented.
  let reviewSeen = 0;
  const decidedRows = params.get('decided') === '0' ? [] : [
    { id: 'D-41', itemId: 'fx-victor-merge', threadTitle: 'Operator reconnect double-send', class: 'merge-when-green', level: 4, status: 'acted', summary: 'Merged #372: approved, CI green, every review thread resolved', undo: 'Revert the merge commit on main and redeploy', ref: 'https://github.com/example/tango/pull/372', at: now - 25 * MIN },
    { id: 'D-40', itemId: 'loom:fx-review-merge', threadTitle: 'Search ranking tweak', class: 'pr-housekeeping', level: 4, status: 'acted', summary: 'Marked #381 ready for review and closed the superseded draft #377', undo: 'Reopen #377 and set #381 back to draft', ref: null, at: now - 70 * MIN },
    { id: 'D-38', itemId: 'fx-victor-merge', threadTitle: 'Operator reconnect double-send', class: 'product-choice-in-scope', level: 3, status: 'defaulted', summary: 'Show the reconnect banner only after 5 seconds offline? Recommend: yes. → A · After 5 seconds', undo: null, ref: null, at: now - 3 * 60 * MIN },
  ].map((d) => ({ reversedAt: null, reversal: null, reversalNote: null, ...d }));
  // What the learning loop changed (decisions phase 3): a new rule and a demotion, invented.
  const ruleRows = params.get('decided') === '0' ? [] : [
    { id: 'E-6', kind: 'class-demoted', at: now - 2 * 60 * MIN, rule: null, class: 'pr-housekeeping', decision: 'D-37', itemId: null, fromLevel: 4, toLevel: 3, text: 'pr-housekeeping dropped from level 4 to 3: 2 reversals in 30 days', ruleChoice: null, state: null },
  ];

  // The catch-up (desk/catchup-actions.ts): Desk reliability's chapter since last night, invented.
  const line = (id, kind, moment, title, extra = {}) => ({ id, spaceId: 'project:desk-reliability', itemId: null, kind, moment, title, detail: null, refs: [], shot: null, briefId: null, decisionId: null, class: null, data: {}, at: now - id * 7 * MIN, seenAt: null, seenVia: null, outcome: null, backAt: null, resolvedAt: null, supersededBy: null, ...extra });
  let chapterLines = params.get('chapter') === '0' ? [] : [
    line(1, 'needs', true, 'Approve the next filter steps?', { itemId: 'loom:fx-desk-lead', briefId: 'D-6', detail: 'Steps 4, 6 and 7 add saved filters, mutes per space and a filter bar on the List.' }),
    line(2, 'shipped', true, 'Decided for you is live on your Inbox', { itemId: 'fx-victor-merge', detail: 'What agents decided for you shows on the Inbox with Undo and “I wouldn’t have”.', refs: [{ label: 'PR #372', url: 'https://github.com/example/tango/pull/372' }] }),
    line(3, 'decided', true, 'Show the reconnect banner after 5 seconds offline', { itemId: 'fx-victor-merge', decisionId: 'D-38', class: 'product-choice-in-scope', detail: 'Ran by default (level 3).' }),
    line(4, 'shipped', false, 'One shared query evaluator (#759)'),
    line(5, 'shipped', false, 'No blank status pills on to-dos (#766)'),
    line(6, 'decided', false, 'Merged #372 once green and reviewed', { decisionId: 'D-41', class: 'merge-when-green' }),
    line(7, 'fyi', false, 'Voice picked up the new wake word'),
    line(8, 'decided', true, 'R-9: for reconnect banners, show them after 5 seconds offline', { itemId: 'fx-victor-merge', decisionId: 'D-39', class: 'product-choice-in-scope', data: { ruleEvent: 'rule-created', rule: 'R-9', ruleChoice: 'always' } }),
  ];
  // Other spaces' chapters in brief (the sidebar's dots, the Inbox summary), invented.
  const otherChapters = params.get('chapter') === '0' ? [] : [
    { spaceId: 'agent:sierra', headline: 'The Bike quote came back; the brake job is booked for Thursday.', status: null, state: 'news', moments: 1, needs: 0, smaller: 2, since: now - 9 * HOUR, lastAt: now - 40 * MIN, backAt: null },
    { spaceId: 'project:voice', headline: 'Wake word retrained overnight.', status: null, state: 'news', moments: 1, needs: 0, smaller: 1, since: now - 6 * HOUR, lastAt: now - 2 * HOUR, backAt: null },
    { spaceId: 'project:house', headline: null, status: null, state: 'news', moments: 0, needs: 0, smaller: 3, since: now - 11 * HOUR, lastAt: now - 3 * HOUR, backAt: null },
    { spaceId: 'project:billing', headline: 'Invoices are out.', status: 'Caught up.', state: 'caught_up', moments: 0, needs: 0, smaller: 0, since: null, lastAt: now - DAY, backAt: null },
  ];
  const fxAsk = 'Finish the filter upgrade: steps 4, 6 and 7? Recommend: all three.';
  const fxOptions = ['A · Build 4, 6 and 7 (Recommended)', 'B · Only step 6', 'C · Stop after step 5'];
  let chapterHandled = [];
  const chapterSnoozed = new Map();
  const isSnoozed = (l) => (chapterSnoozed.get(l.id) || 0) > Date.now();
  // Other spaces' chapters in full (an agent's space has one too; Catch me up reads them all), invented.
  const otherLines = otherChapters.length ? {
    'agent:sierra': [
      line(21, 'shipped', true, 'The Bike quote came back: $640 for the brakes', { spaceId: 'agent:sierra', detail: 'Booked for Thursday at 9; the shop has the car by noon.' }),
      line(22, 'fyi', false, 'Trailer research: three hitches shortlisted', { spaceId: 'agent:sierra' }),
      line(23, 'fyi', false, 'The coast loop closures are posted through Sunday', { spaceId: 'agent:sierra' }),
    ],
    'project:voice': [
      line(31, 'shipped', true, 'Wake word retrained overnight', { spaceId: 'project:voice', detail: 'False wakes in the kitchen fell from 9 a day to 1.' }),
      line(32, 'fyi', false, 'Voice lab notes tidied', { spaceId: 'project:voice' }),
    ],
    'project:house': [
      line(41, 'fyi', false, 'Filter reminder set for the 1st', { spaceId: 'project:house' }),
      line(42, 'fyi', false, 'Garage door sensor battery at 20%', { spaceId: 'project:house' }),
      line(43, 'shipped', false, 'Sprinkler schedule moved to fall hours', { spaceId: 'project:house' }),
    ],
  } : {};
  const rawOtherNow = (spaceId) => {
    const all = otherLines[spaceId];
    const open = all.filter((l) => !chapterHandled.includes(l.id) && !isSnoozed(l));
    const base = otherChapters.find((c) => c.spaceId === spaceId);
    const moments = open.filter((l) => l.moment).length;
    return {
      chapter: { ...base, moments, smaller: open.length - moments, ...(open.length ? {} : { state: 'caught_up', since: null, status: 'Caught up.' }) },
      lines: open,
      waiting: [],
      recent: all.filter((l) => chapterHandled.includes(l.id)).map((l) => ({ ...l, seenAt: now, seenVia: 'accepted' })),
      plan: { spaceId, revision: `fx-${spaceId}-${open.length}`, updateIds: open.map((l) => l.id), take: [], fine: [], left: [], seen: open.map((l) => l.id), line: open.length ? 'Accept will mark the rest seen.' : 'Nothing for Accept to do.' },
      briefs: [],
    };
  };
  const rawChapterNow = () => {
    const open = chapterLines.filter((l) => !chapterHandled.includes(l.id) && !isSnoozed(l));
    const take = open.filter((l) => l.kind === 'needs').map((l) => ({ updateId: l.id, itemId: l.itemId, briefId: l.briefId, answer: fxOptions[0], key: 'A', revision: 2, candidate: true }));
    const fine = open.filter((l) => l.kind === 'decided' && l.moment).map((l) => ({ updateId: l.id, decisionId: l.decisionId }));
    const seen = open.filter((l) => !take.some((t) => t.updateId === l.id) && !fine.some((f) => f.updateId === l.id)).map((l) => l.id);
    const parts = [take.length ? `choose ${take.map((t) => `A on ${t.briefId}`).join(', ')}` : null, fine.length ? `fine on ${fine.length} decision${fine.length === 1 ? '' : 's'}` : null, seen.length ? 'mark the rest seen' : null].filter(Boolean);
    const lineText = parts.length ? `Accept will ${parts.join(' · ')}.` : 'Nothing for Accept to do.';
    return {
      chapter: { spaceId: 'project:desk-reliability', headline: chapterLines.some((l) => !chapterHandled.includes(l.id)) ? 'Decided for you shipped overnight. The next filter steps are the one thing waiting on you.' : 'Decided for you is live; the filter steps are approved and starting.', status: chapterLines.some((l) => !chapterHandled.includes(l.id)) ? null : 'Building filter steps 4, 6 and 7.', state: open.length ? 'news' : 'caught_up', moments: open.filter((l) => l.moment).length, needs: open.filter((l) => l.kind === 'needs').length, smaller: open.filter((l) => !l.moment).length, since: open.length ? now - 12 * HOUR : null, lastAt: now - 7 * MIN, backAt: null },
      lines: open,
      waiting: [],
      recent: chapterLines.filter((l) => chapterHandled.includes(l.id)).map((l) => ({ ...l, seenAt: now, seenVia: 'accepted' })),
      plan: { spaceId: 'project:desk-reliability', revision: `fx${open.length}`, updateIds: open.map((l) => l.id), take, fine, left: [], seen, line: lineText },
      briefs: open.some((l) => l.briefId === 'D-6') ? [{ id: 'D-6', itemId: 'loom:fx-desk-lead', ask: fxAsk, standing: 'Steps 1 to 3 are live; step 5 is half built behind a flag.', options: fxOptions.map((o, i) => ({ key: o.split(' · ')[0], label: o.replace(/\s*\(Recommended\)$/, '').split(' · ').slice(1).join(' · '), consequence: ['Two days; all three ship together', 'Half a day; 4 and 7 wait for the next round', 'Nothing more is built'][i] || null, recommended: /\(Recommended\)$/.test(o) })), defaultOption: null, vetoLeftMs: null, level: 2 }] : [],
    };
  };

  const withSnooze = (data, all) => {
    const snoozed = all.filter(isSnoozed).map((l) => ({ ...l, seenAt: now, seenVia: 'deferred', outcome: 'later', backAt: chapterSnoozed.get(l.id) }));
    if (!snoozed.length) return data;
    data.waiting.push(...snoozed.filter((l) => l.kind === 'needs'));
    data.recent.push(...snoozed.filter((l) => l.kind !== 'needs'));
    data.chapter.backAt = Math.min(...snoozed.map((l) => l.backAt));
    data.chapter.needs += snoozed.filter((l) => l.kind === 'needs').length;
    if (!data.chapter.moments) data.chapter.state = 'deferred';
    return data;
  };
  const otherNow = (spaceId) => withSnooze(rawOtherNow(spaceId), otherLines[spaceId]);
  const chapterNow = () => withSnooze(rawChapterNow(), chapterLines);

  /** Search over the invented items: every word somewhere in the title or a message (no meaning here). */
  function searchFixtures(q, query, limit) {
    const words = String(q).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
    const mark = (text) => words.reduce((out, w) => out.replace(new RegExp(`(${w})`, 'ig'), '\u0002$1\u0003'), text);
    const hits = [];
    for (const i of db.items) {
      if (!queryMatches(publicItem(i), query, { projects: settings.projects || [] })) continue;
      const title = `${i.facts?.name || ''} ${i.place || ''} ${i.summary?.title || ''}`;
      const messages = db.messages[i.id] || [];
      const all = `${title} ${messages.map((m) => m.text).join(' ')}`.toLowerCase();
      if (!words.length || !words.every((w) => all.includes(w))) continue;
      const matched = messages.filter((m) => words.some((w) => m.text.toLowerCase().includes(w)));
      const matches = [
        ...(words.some((w) => title.toLowerCase().includes(w)) ? [{ messageId: null, author: null, at: null, snippet: mark(title.trim()), how: 'title' }] : []),
        ...matched.slice(0, 3).map((m) => ({ messageId: m.messageId, author: m.author, at: m.at, snippet: mark(m.text.slice(0, 200)), how: 'keyword' })),
      ];
      hits.push({ itemId: i.id, score: matches.length, matchCount: matched.length, matches, row: publicItem(i) });
    }
    return { query: q, semantic: false, total: hits.length, more: false, tokens: [], hits: hits.sort((a, b) => b.score - a.score).slice(0, limit) };
  }

  return {
    mode: 'fixtures',
    async chapters() {
      await delay(30);
      return clone({ chapters: [...(chapterLines.length ? [chapterNow().chapter] : []), ...otherChapters.map((c) => (otherLines[c.spaceId] ? otherNow(c.spaceId).chapter : c))] });
    },
    async chapter(spaceId) {
      await delay(30);
      if (otherLines[spaceId]) return clone(otherNow(spaceId));
      if (spaceId !== 'project:desk-reliability' || !chapterLines.length) throw Object.assign(new Error('no chapter'), { status: 404, body: { error: 'no chapter' } });
      return clone(chapterNow());
    },
    async chapterAccept(spaceId, { revision }) {
      await delay(150);
      if (otherLines[spaceId]) {
        const plan = otherNow(spaceId).plan;
        if (revision !== plan.revision) throw Object.assign(new Error('changed'), { status: 409, body: { error: 'The chapter changed since you saw it', changed: true, plan } });
        chapterHandled = [...chapterHandled, ...plan.updateIds];
        return { ok: true, plan, applied: { took: [], fine: [], seen: plan.seen.length }, left: [], failed: [] };
      }
      const plan = chapterNow().plan;
      if (revision !== plan.revision) throw Object.assign(new Error('changed'), { status: 409, body: { error: 'The chapter changed since you saw it', changed: true, plan } });
      chapterHandled = [...chapterHandled, ...plan.updateIds];
      return { ok: true, plan, applied: { took: plan.take.map((t) => t.briefId), fine: plan.fine.map((f) => f.decisionId), seen: plan.seen.length }, left: [], failed: [] };
    },
    async chapterDefer(spaceId, { backAt = now + 12 * HOUR, revision } = {}) {
      await delay(120);
      const plan = (otherLines[spaceId] ? otherNow(spaceId) : chapterNow()).plan;
      if (revision !== plan.revision) throw Object.assign(new Error('changed'), { status: 409, body: { changed: true } });
      for (const id of plan.updateIds) chapterSnoozed.set(id, backAt);
      return { ok: true, backAt, deferred: plan.updateIds.length };
    },
    async decidedConfirm({ decisionId }) {
      await delay(100);
      chapterHandled = [...chapterHandled, ...chapterLines.filter((l) => l.decisionId === decisionId).map((l) => l.id)];
      return { ok: true };
    },
    async updatesSeen({ ids, via, backAt = now + 12 * HOUR }) {
      await delay(100);
      if (via === 'deferred') for (const id of ids) chapterSnoozed.set(id, backAt);
      else chapterHandled = [...chapterHandled, ...ids];
      return { ok: true, updates: [] };
    },
    async decidedRule({ decisionId, rule }) {
      await delay(120);
      const item = db.items.find((i) => i.facts?.rulesSaved?.some((s) => s.decisionId === decisionId));
      if (item) {
        const saved = item.facts.rulesSaved.find((s) => s.decisionId === decisionId);
        // One decision, one rule: Always again brings the same rule back; a proposal becomes its rule.
        const fromProposal = rule === 'always' && saved.proposal?.state === 'proposed';
        const ruleId = fromProposal ? 'R-15' : saved.ruleId;
        const text = fromProposal ? saved.proposal.text.replace(/^Next time, /, '').replace(/ without asking$/, '') : saved.text;
        const proposal = saved.proposal ? { ...saved.proposal, state: fromProposal ? 'made' : rule === 'always' ? saved.proposal.state : 'dismissed' } : null;
        const next = { ...saved, choice: rule, ruleId, text, proposal, ruleState: rule === 'always' ? 'active' : saved.ruleId ? 'retired' : null };
        item.facts = { ...item.facts, rulesSaved: item.facts.rulesSaved.map((s) => (s.decisionId === decisionId ? next : s)) };
        return { ok: true, rule: rule === 'always' ? ruleId : null, ruleState: next.ruleState };
      }
      const row = ruleRows.find((r) => r.decision === decisionId && r.kind === 'rule-created');
      if (!row) throw Object.assign(new Error('Loom no longer has that decision'), { status: 409, body: { error: 'Loom no longer has that decision' } });
      Object.assign(row, { ruleChoice: rule, state: rule === 'always' ? 'active' : 'retired' });
      // As the live route does: its new-rule line carries the choice and is handled.
      for (const l of chapterLines.filter((l) => l.decisionId === decisionId && l.data?.ruleEvent)) l.data = { ...l.data, ruleChoice: rule };
      chapterHandled = [...chapterHandled, ...chapterLines.filter((l) => l.decisionId === decisionId && l.data?.ruleEvent).map((l) => l.id)];
      return { ok: true, ruleState: row.state };
    },
    async decidedReview() {
      await delay(30);
      if (params.get('decided') === '0') return { due: false, seenAt: null, review: { since: now - 7 * DAY, until: now, created: [], suspended: [], demoted: [], due: [], dissent: [] } };
      return clone({ due: !reviewSeen, seenAt: reviewSeen || null, review: {
        since: now - 7 * DAY, until: now,
        created: [{ at: now - 15 * MIN, rule: 'R-9', class: 'product-choice-in-scope', decision: 'D-39', text: 'R-9: for reconnect banners, show them after 5 seconds offline' }],
        suspended: [{ at: now - 2 * DAY, kind: 'rule-suspended', rule: 'R-6', class: 'merge-when-green', text: 'R-6 suspended: Undo on D-30: wait for the second review' }],
        demoted: [{ at: now - 2 * 60 * MIN, kind: 'class-demoted', class: 'pr-housekeeping', from_level: 4, to_level: 3, text: 'pr-housekeeping dropped from level 4 to 3: 2 reversals in 30 days' }],
        due: [],
        dissent: [{ class: 'product-choice-in-scope', rule: 'R-4', count: 2, notes: [{ decision: 'D-33', text: 'rows have room for a count', at: now - 3 * DAY }, { decision: 'D-36', text: 'still think the row should show it', at: now - DAY }] }],
      } });
    },
    async decidedReviewSeen({ until } = {}) {
      await delay(30);
      reviewSeen = until || Date.now();
      return { ok: true, seenAt: reviewSeen };
    },
    async decidedReverse({ decisionId, undo, note }) {
      await delay(120);
      const row = decidedRows.find((d) => d.id === decisionId);
      if (!row) throw Object.assign(new Error('Loom no longer has that decision'), { status: 409, body: { error: 'Loom no longer has that decision' } });
      if (row.reversal) throw Object.assign(new Error('Decision was already reversed'), { status: 409, body: { error: `Decision ${row.id} was already reversed` } });
      Object.assign(row, { reversal: undo ? 'undo' : 'disagree', reversalNote: note || null, reversedAt: Date.now() });
      // As the live route does: the decision's catch-up line is handled.
      chapterHandled = [...chapterHandled, ...chapterLines.filter((l) => l.decisionId === decisionId).map((l) => l.id)];
      return { ok: true };
    },
    // The Screen window's feed (feed.js; desk/feed.ts): a few invented posts.
    async feed() {
      const now = Date.now();
      const min = 60_000;
      const post = (seq, ago, kind, extra) => ({ seq, at: now - ago, firstAt: now - ago, kind, itemId: null, projectId: null, agentName: '', title: '', text: '', count: 1, data: {}, ...extra });
      return {
        posts: [
          post(5, 3 * min, 'update', { itemId: 'fx-juliet-ferry', agentName: 'Juliet', title: 'Saturday sailing has room', text: 'The 9:10 has two vehicle spots left; the 11:30 is full.', count: 2 }),
          post(4, 18 * min, 'pr', { itemId: 'loom:fx-review-merge', agentName: 'Loom', title: 'PR #381 approved by sam', text: 'Search ranking tweak' }),
          post(3, 40 * min, 'screen', { itemId: 'fx-victor-merge', agentName: 'Victor', title: 'Reconnect timeline', data: { id: 'fx-scene-gone' } }),
          post(2, 90 * min, 'project', { title: 'Desk reliability', text: 'Two of three fixes are live; the migration still waits on a dry run.' }),
          post(1, 5 * 60 * min, 'done', { itemId: 'fx-deck-quote', agentName: 'Foxtrot', title: 'Deck stain quote', text: 'Went with the warrantied bid.' }),
        ],
      };
    },
    async coordinators() {
      await delay(30);
      return { coordinators: Object.keys(coord).map(coordSummary) };
    },
    async coordinator(projectId) {
      await delay(80);
      const c = coord[projectId];
      if (!c) return { summary: null, threadId: null, itemId: null, messages: [], running: false, drafts: [], digests: [], error: null };
      return clone({ summary: coordSummary(projectId), threadId: c.threadId, itemId: c.threadId ? `loom:${c.threadId}` : null, messages: c.messages, running: c.running, drafts: c.drafts.filter((d) => d.state !== 'dropped'), digests: c.digests, error: null });
    },
    async coordinatorAsk(projectId, { text, fromItemId }) {
      await delay(200);
      const c = coordFor(projectId);
      c.threadId ||= `fx-coord-${projectId}`;
      c.messages.push({ id: `fxq${Date.now()}`, kind: 'question', text, at: Date.now(), fromItemId: fromItemId || null });
      c.running = true;
      coordTouch(projectId);
      setTimeout(() => {
        const answer = /chang|since|yesterday/i.test(text) ? CANNED[1] : /me\b|on me|waiting/i.test(text) ? CANNED[2] : CANNED[c.asked++ % 3];
        c.messages.push({ id: `fxa${Date.now()}`, kind: 'answer', text: answer, at: Date.now() });
        c.running = false;
        coordTouch(projectId);
      }, 1800);
      return { ok: true, threadId: c.threadId };
    },
    async coordinatorWatch(projectId, patch) {
      await delay(80);
      const c = coordFor(projectId);
      for (const key of ['on', 'stands', 'flags', 'digest']) if (typeof patch[key] === 'boolean') c.watch[key] = patch[key];
      if (patch.reach) c.reach = patch.reach;
      if (c.watch.on && !c.status) c.status = { text: 'Two conversations are working and nothing waits on you.', line: '2 working; nothing waits on you.', at: Date.now(), source: 'model' };
      coordTouch(projectId);
      return coordSummary(projectId);
    },
    async coordinatorDraft(projectId, draftId, { action, text }) {
      await delay(120);
      const c = coord[projectId];
      const d = c?.drafts.find((x) => x.id === draftId);
      if (!d) throw Object.assign(new Error('no such question'), { body: { error: 'no such question' } });
      if (text) d.text = text;
      if (action === 'drop') d.state = 'dropped';
      else {
        d.state = action === 'now' ? 'sent' : 'queued';
        setTimeout(() => ((d.state = 'sent'), coordTouch(projectId)), action === 'now' ? 0 : 1500);
        setTimeout(() => {
          d.state = 'answered';
          d.answer = { text: 'Retried with the type fixed; tests pass. 90s was too tight: deploys take about 70s and one slow restart tripped it. I set 120s and pushed it to the same branch.', at: Date.now() };
          c.messages.push({ id: `fxr${Date.now()}`, kind: 'relay', text: `“${d.toTitle}” (${d.toItemId}) answered your question.`, at: Date.now() });
          c.messages.push({ id: `fxa${Date.now()}`, kind: 'answer', text: `So [Health-check tuning](desk:${d.toItemId}) is unblocked and back to ready. That leaves two decisions on you: [Desk storage migration](desk:loom:fx-migrate) and [operator-dependability](desk:fx-victor-merge).`, at: Date.now() + 1 });
          coordTouch(projectId);
        }, 4000);
      }
      coordTouch(projectId);
      return { ok: true, draft: clone(d) };
    },
    async items({ view = 'active' } = {}) {
      await delay(60);
      const pick = {
        active: (i) => i.disposition === 'active',
        snoozed: (i) => i.disposition === 'snoozed' || i.disposition === 'parked',
        everything: (i) => i.disposition !== 'done',
        history: (i) => i.disposition === 'done',
      }[view] || (() => false);
      const list = db.items
        .filter((i) => !i.hidden && pick(shown(i)))
        .map((i) => {
          const item = publicItem(i);
          const matches = filterMatches(i, settings.filters);
          return matches.length ? { ...item, filteredBy: matches } : item;
        });
      const sweepItems = db.items.filter((i) => i.disposition === 'parked' && !i._swept && Date.now() - i.lastActivityAt > 7 * DAY);
      return { items: list, counts: counts(), sweep: view === 'active' && sweepItems.length ? { day: 'saturday', items: sweepItems.map(publicItem) } : null };
    },
    // include=open: open ones only, with what done ones would add (`wider`), as the server does.
    async search(q, { limit = 150, where = {}, scope = 'global', audience = 'all', include = 'all' } = {}) {
      await delay(80);
      const query = { where, audience, scope: scope.startsWith('space:') ? { kind: 'space', id: scope.slice(6) } : { kind: 'global' } };
      const open = include === 'open' ? openOnly(query) : null;
      const result = searchFixtures(q, open || query, limit);
      return open ? { ...result, wider: { total: Math.max(0, searchFixtures(q, query, limit).total - result.total), more: false } } : result;
    },
    async transcript(id, { around } = {}) {
      await delay(60);
      const item = find(id);
      if (!item) throw Object.assign(new Error('not found'), { status: 404 });
      return { row: publicItem(item), messages: clone(db.messages[id] || []), hasEarlier: false, hasLater: false, around };
    },
    async item(id) {
      await delay(60);
      const item = find(id);
      if (!item) throw Object.assign(new Error('not found'), { status: 404 });
      const scenes = Object.values(db.scenes)
        .filter((s) => s.conversationKey === item.conversationKey)
        .sort((a, b) => b.updatedAt - a.updatedAt);
      const messages = clone(db.messages[id] || []).slice(-30);
      return { item: publicItem(item), messages, timeline: clone(db.timelines[id] || []), beats: fixtureBeats(messages), scenes: clone(scenes), prototypes: clone(prototypesIn(item.conversationKey)) };
    },
    async activity({ limit = 50 } = {}) {
      await delay(40);
      return { events: clone(events.slice(0, limit)) };
    },
    async settings() {
      return clone(settings);
    },
    async saveSettings(body) {
      await delay(40);
      if (body.filters) settings = { ...settings, filters: normalizeFilters(body.filters) };
      if (body.sweepDay) settings = { ...settings, sweepDay: body.sweepDay };
      if (body.labelOrder) settings = { ...settings, labelOrder: labelOrderOf(body.labelOrder) };
      if (body.snoozeTimes) settings = { ...settings, snoozeTimes: { ...(settings.snoozeTimes || {}), ...body.snoozeTimes } };
      if ('spaceViews' in body) settings = { ...settings, spaceViews: body.spaceViews || null };
      if ('listViews' in body) settings = { ...settings, listViews: body.listViews || null };
      if (Array.isArray(body.projects)) settings = { ...settings, projects: body.projects };
      if (Array.isArray(body.projectSectionsHidden)) settings = { ...settings, projectSectionsHidden: body.projectSectionsHidden };
      if (body.spaces && typeof body.spaces === 'object') settings = { ...settings, spaces: { ...(settings.spaces || {}), ...body.spaces } };
      if (body.agentIcons) {
        // As the live endpoint: merge, and null drops an agent back to its default.
        const agentIcons = { ...(settings.agentIcons || {}) };
        for (const [agent, value] of Object.entries(body.agentIcons)) {
          if (value === null) delete agentIcons[agent];
          else agentIcons[agent] = { icon: String(value.icon), color: value.color ?? null };
        }
        settings = { ...settings, agentIcons };
      }
      if (body.repoIcons) {
        // The same per repo, kept by its name in lower case.
        const repoIcons = { ...(settings.repoIcons || {}) };
        for (const [repo, value] of Object.entries(body.repoIcons)) {
          if (value === null) delete repoIcons[repo.trim().toLowerCase()];
          else repoIcons[repo.trim().toLowerCase()] = { icon: String(value.icon), color: value.color ?? null };
        }
        settings = { ...settings, repoIcons };
      }
      emit('onSettings', settings);
      return clone(settings);
    },
    async projectAction(projectId, body) {
      // As the desk does it (core.projectAction): Snooze, Park and Wake set the project's own state only
      // (shown() holds what is in rotation); Finish acts on the open ones.
      await delay(40);
      const project = (settings.projects || []).find((p) => p.id === projectId);
      if (!project || project.finishedAt) throw Object.assign(new Error('no such open project'), { body: { error: 'no such open project' } });
      const kids = (settings.projects || []).filter((p) => p.parent === `project:${projectId}` && !p.finishedAt);
      const ending = new Set([projectId, ...(body.children === 'finish' ? kids.map((k) => k.id) : [])]);
      const put = (patch) => {
        settings = { ...settings, projects: settings.projects.map((p) => (p.id === projectId ? { ...p, ...patch } : p)), projectsRev: (settings.projectsRev || 0) + 1 };
        emit('onSettings', settings);
        emit('onItem', null);
      };
      if (body.action === 'snooze' || body.action === 'park' || body.action === 'wake') {
        const now = Date.now();
        put({ away: body.action === 'wake' ? null : body.action === 'park' ? { state: 'parked', at: now } : { state: 'snoozed', at: now, until: body.until ? Date.parse(body.until) : null, trigger: body.trigger || null } });
        return { held: db.items.filter((i) => shown(i).heldBy === projectId).length };
      }
      let acted = 0;
      let stayed = 0;
      const upTo = (id) => {
        const parent = (settings.projects || []).find((p) => p.id === id)?.parent;
        return parent?.startsWith('project:') && !ending.has(parent.slice(8)) ? parent.slice(8) : null;
      };
      for (const item of db.items.filter((i) => ending.has(i.facts?.projectId) && ['active', 'snoozed', 'parked'].includes(i.disposition || 'active'))) {
        if (item.nextStep === 'working') {
          stayed += 1;
          continue;
        }
        acted += 1;
        if (body.how === 'out') item.facts = { ...item.facts, projectId: upTo(item.facts.projectId) };
        else Object.assign(item, { disposition: 'done', doneAt: Date.now() });
      }
      const at = Date.now();
      settings = {
        ...settings,
        projects: settings.projects.map((p) => {
          if (ending.has(p.id)) return { ...p, finishedAt: at, away: null };
          if (kids.some((k) => k.id === p.id)) {
            const { parent: _parent, ...rest } = p;
            return rest;
          }
          return p;
        }),
        projectsRev: (settings.projectsRev || 0) + 1,
      };
      emit('onSettings', settings);
      emit('onItem', null);
      return { acted, stayed, ...(kids.length ? { finished: ending.size - 1, keptOpen: body.children === 'finish' ? 0 : kids.length } : {}) };
    },
    async icons(q = '') {
      // Read-only and static: the real list when a desk server is serving the page, else a few.
      try {
        const res = await fetch(`api/desk/icons?q=${encodeURIComponent(q)}`);
        if (res.ok) return await res.json();
      } catch {}
      return { icons: ['circle', 'star', 'heart', 'briefcase', 'compass', 'leaf', 'rocket', 'folder'].filter((n) => n.includes(q.trim().toLowerCase())) };
    },
    async facets() {
      await delay(40);
      return facetsFor(db.items, settings.filters);
    },
    async briefing() {
      const active = db.items.map(shown).filter((i) => i.disposition === 'active' && !filtered(i));
      return { yourMove: active.filter((i) => i.nextStep === 'your_move' || i.nextStep === 'failed').map(publicItem), fyi: [] };
    },
    async presentation() {
      return clone(presentation);
    },
    async present(intent) {
      await delay(40);
      const item = intent.itemId ? find(intent.itemId) : null;
      const sceneId = intent.view === 'screen' ? intent.sceneId || Object.values(db.scenes).find((s) => item && s.conversationKey === item.conversationKey)?.id || null : intent.view === 'conversation' ? null : null;
      presentation = {
        ...presentation,
        view: intent.view,
        itemId: intent.view === 'active' ? null : intent.itemId ?? presentation.itemId,
        conversationKey: intent.view === 'active' ? null : intent.conversationKey ?? item?.conversationKey ?? presentation.conversationKey,
        sceneId,
        queue: presentation.queue.filter((id) => id !== sceneId),
        queueScenes: presentation.queueScenes.filter((q) => q.sceneId !== sceneId),
        by: 'screen',
        since: Date.now(),
      };
      presentation.upNext = presentation.queueScenes[0] || null;
      presentation.prototypes = presentation.conversationKey ? prototypesIn(presentation.conversationKey) : [];
      presentation.prototype = intent.view === 'prototype' ? presentation.prototypes.find((p) => p.id === intent.prototypeId) || presentation.prototypes[0] || null : null;
      presentation.prototypeId = presentation.prototype?.id || null;
      emit('onPresentation', presentation);
      return clone(presentation);
    },
    async presence() {
      return { ok: true, fired: [] };
    },
    async command(cmd) {
      if (commands.has(cmd.commandId)) return clone(commands.get(cmd.commandId));
      await delay(cmd.type === 'reply' || cmd.type === 'answer' ? 700 : 300);
      if (failing.delete(cmd.type)) return { commandId: cmd.commandId, status: 'failed', error: 'the agent is restarting (fixture)' };
      const result = { commandId: cmd.commandId, ...apply(cmd) };
      commands.set(cmd.commandId, result);
      return clone(result);
    },
    // A brief's page (TGO-1110), from the open brief a fixture thread raised: the same pending, answered on that thread.
    async decisionIds() {
      return { ids: db.items.flatMap((i) => (i.facts?.pending?.brief ? [Number(i.facts.pending.brief.id.slice(2))] : [])) };
    },
    async decision(id) {
      const item = db.items.find((i) => i.facts?.pending?.brief?.id === id && !i.facts.pending.brief.from);
      if (!item) throw Object.assign(new Error('not found'), { status: 404 });
      const pending = clone(item.facts.pending);
      const carriers = db.items.filter((i) => i.facts?.pending?.brief?.id === id && i.id !== item.id).map((i) => ({ itemId: i.id, title: i.facts?.name || i.place }));
      return { id, status: 'open', ask: pending.question, class: pending.brief.class, level: pending.brief.level, revision: pending.brief.revision || 1, createdAt: pending.at, raisedOn: { itemId: item.id, title: item.facts?.name || item.place }, carriedBy: carriers, pending, brief: null, changes: [], outcome: null };
    },
    async scene(id) {
      const scene = db.scenes[id];
      if (!scene) throw Object.assign(new Error('not found'), { status: 404 });
      return clone(scene);
    },
    frameUrl: (scene) => sceneDoc(db.scenes[scene.id] || scene),
    prototypeUrl: () =>
      `data:text/html;charset=utf-8,${encodeURIComponent('<!doctype html><title>Onboarding</title><body style="font:16px system-ui;margin:0;padding:40px;background:#fff;color:#111"><h1>Welcome aboard</h1><p>Step 1 of 3: pick a workspace.</p><button>Continue</button> <a href="#">Skip for now</a><div style="height:1400px"></div><h2>Pricing</h2></body>')}`,
    prototypePage: async () => ({ ok: true }),
    prototypeResult: async () => ({ ok: true }),
    prototypeActivity: async () => ({ ok: true }),
    async input(body) {
      await delay(200);
      const scene = db.scenes[body.sceneId];
      emit('onAck', { sceneId: body.sceneId, agentName: scene?.agentName || 'the agent', label: body.data?.value, routed: 'agent' });
      return { ok: true };
    },
    unlockAudio: async () => {},
    async draftCommand(action, draftId) {
      if (draft && draft.id && draftId !== draft.id) throw Object.assign(new Error('that draft is no longer the current one'), { status: 409 });
      await delay(200);
      if (!draft) return { dismissed: true };
      draft = action === 'send' ? { ...draft, active: false, status: 'sent', updatedAt: Date.now() } : action === 'cancel' ? { ...draft, active: false, status: 'cancelled', updatedAt: Date.now() } : null;
      emit('onDraft', draft || { active: false, fragments: [], status: 'listening', updatedAt: Date.now() });
      return { accepted: true };
    },
    async startWorkOptions() {
      await delay(150);
      const H = 3_600_000;
      const u = (weekly, session, resetIn, extra = {}) => ({ weekly, session, resetsAt: new Date(Date.now() + resetIn).toISOString(), useBeforeReset: false, excluded: false, status: 'fresh', rank: null, ...extra });
      return {
        policyModel: 'claude-opus-5-5',
        // Loom runs here: every repo starts on it, inside the accounts its routing allows.
        repos: [
          { id: 'p-tango', name: 'tango', account: 'loom', loomSeats: ['claude_home'], loomPick: 'claude_home', mode: 'worktree' },
          { id: 'p-acme', name: 'acme', account: 'loom', loomSeats: ['claude_team', 'claude_spare'], loomPick: 'claude_spare', pool: ['claude_team', 'claude_spare'], mode: 'worktree' },
          { id: 'p-studio', name: 'demo-studio', account: 'loom', loomSeats: ['claude_home'], loomPick: 'claude_home', mode: 'worktree' },
        ],
        accounts: [
          { id: 'claude_home', name: 'Claude (Home)', driver: 'claudeAgent', model: 'claude-opus-5-5', color: '#7c3aed', usage: u(77, 98, 40 * H, { excluded: true }) },
          { id: 'claude_team', name: 'Claude (Team)', driver: 'claudeAgent', model: 'claude-opus-5-5', color: '#0891b2', usage: u(94, 97, 6 * 24 * H, { rank: 1 }) },
          { id: 'claude_spare', name: 'Claude (Spare)', driver: 'claudeAgent', model: 'claude-opus-5-5', color: '#d79504', usage: u(91, 100, 26 * H, { rank: 0, useBeforeReset: true }) },
          { id: 'codex', name: 'ChatGPT (Home)', driver: 'codex', model: 'gpt-6-astra', color: '#7c3aed', usage: u(100, null, 7 * 24 * H, { rank: 0 }) },
          { id: 'codex_work', name: 'ChatGPT (Work)', driver: 'codex', model: 'gpt-6-astra', color: '#0891b2', usage: u(100, null, 7 * 24 * H, { rank: 1 }) },
          { id: 'loom', name: 'Loom (best account)', driver: 'loom', model: 'Claude' },
        ],
        agents: [{ id: 'foxtrot', name: 'Foxtrot' }, { id: 'sierra', name: 'Sierra' }, { id: 'watson', name: 'Watson' }],
        fields: { required: ['repo', 'prompt'], defaults: ['title', 'account', 'mode', 'plan'] },
        policyError: null,
      };
    },
    async startWork(body) {
      await delay(600);
      if (failing.delete('start')) throw Object.assign(new Error('Loom is restarting (fixture)'), { status: 503, body: { ok: false, error: 'Loom is restarting (fixture)' } });
      const options = await this.startWorkOptions();
      const repo = options.repos.find((r) => r.id === body.repo);
      if (!repo || !String(body.prompt || '').trim()) {
        throw Object.assign(new Error('missing'), { status: 422, body: { ok: false, check: { ready: false, missing: [!repo && 'repo', !body.prompt && 'prompt'].filter(Boolean), problems: [], question: 'Which repo, and what should it work on?' } } });
      }
      const account = options.accounts.find((a) => a.id === (body.account || repo.account));
      const title = body.title || String(body.prompt).split(/(?<=[.?!])\s/)[0].slice(0, 60);
      return { ok: true, threadId: 'fixture-thread', itemId: 'loom:fixture-thread', plan: { repo, account, title, mode: body.mode, plan: body.plan, attachments: (body.attachments || []).length } };
    },
    async startAgentThread(body) {
      await delay(500);
      const agent = { foxtrot: 'Foxtrot', sierra: 'Sierra', watson: 'Watson' }[body.agentId];
      const title = body.title || String(body.prompt || '').split(/(?<=[.?!])\s/)[0].slice(0, 60);
      return { ok: true, itemId: 'discord:thread:fixture', threadId: 'fixture', agent: { id: body.agentId, name: agent }, title };
    },
    async capacity() {
      await delay(150);
      const H = 3_600_000;
      const at = (h) => new Date(Date.now() + h * H).toISOString();
      const t = (id, title, repo, running, minutesAgo, allowed) => ({ itemId: `loom:${id}`, title, repo, running, lastActiveAt: Date.now() - minutesAgo * 60_000, allowed });
      const home = ['claude_home'];
      const team = ['claude_team', 'claude_spare'];
      return {
        updatedAt: Date.now(),
        loom: true,
        moves: false,
        accounts: [
          { id: 'claude_home', name: 'Claude (Home)', color: '#7c3aed', provider: 'claude', status: 'fresh', fiveHour: { left: 85, resetsAt: at(4) }, weekly: { left: 77, resetsAt: at(110) }, running: 3, idle: 4, threads: [
            t('a1', 'Sidebar status indicators', 'tango', true, 2, home), t('a2', 'Bulk actions for list views', 'tango', true, 9, home), t('a3', 'Voice pill in the top bar', 'tango', true, 31, home),
            t('a4', 'Restore right-click actions', 'tango', false, 12, home), t('a5', 'Project settings tab layout', 'tango', false, 140, home), t('a6', 'Inbox filter menu', 'tango', false, 660, home), t('a7', 'Agent thread visibility', 'tango', false, 1100, home),
          ] },
          { id: 'claude_team', name: 'Claude (Team)', color: '#0891b2', provider: 'claude', status: 'fresh', fiveHour: { left: 86, resetsAt: at(1) }, weekly: { left: 54, resetsAt: at(43) }, running: 0, idle: 1, threads: [t('b1', 'Playtest coordinator', 'acme', false, 24, team)] },
          { id: 'claude_spare', name: 'Claude (Spare)', color: '#d79504', provider: 'claude', status: 'fresh', fiveHour: { left: 92, resetsAt: at(5) }, weekly: { left: 91, resetsAt: at(26) }, running: 1, idle: 1, threads: [t('c1', 'Photo Walk slice', 'acme', true, 4, team), t('c2', 'Paddock hub build', 'acme', false, 27, team)] },
          { id: 'codex', name: 'ChatGPT (Home)', color: '#7c3aed', provider: 'codex', status: 'fresh', fiveHour: null, weekly: { left: 100, resetsAt: at(168) }, running: 0, idle: 0, threads: [] },
          { id: 'codex_work', name: 'ChatGPT (Work)', color: '#0891b2', provider: 'codex', status: 'fresh', fiveHour: null, weekly: { left: 97, resetsAt: at(120) }, running: 0, idle: 0, threads: [] },
        ],
        rules: { default: home, repos: [{ repo: 'acme', accounts: team }, { repo: 'tango', accounts: home }], error: null },
        machine: { at: Date.now(), memory: { totalBytes: 64 * 2 ** 30, agents: [{ name: 'Claude sessions', processes: 26, bytes: 10.5 * 2 ** 30 }, { name: 'Brave (agent browsing)', processes: 10, bytes: 1.7 * 2 ** 30 }] }, disk: { totalBytes: 926 * 2 ** 30, freeBytes: 89 * 2 ** 30 }, worktrees: { count: 30 } },
      };
    },
    // The System page (system-fixture.js): its reading, a job's page, and its commands (fail=job.run etc. fail once).
    async system() {
      await delay(120);
      const data = ledger.read();
      return clone({ ...data, updatedAt: Date.now(), capacity: await this.capacity() });
    },
    async systemJob(id) {
      await delay(120);
      const detail = ledger.job(id);
      if (!detail) throw Object.assign(new Error('no such job'), { status: 404 });
      return clone(detail);
    },
    async systemEvents() {
      await delay(80);
      return { events: clone(ledger.read().recentEvents) };
    },
    async systemCommand(cmd) {
      await delay(250);
      if (failing.delete(cmd.type)) return { commandId: cmd.commandId, status: 'failed', error: 'the system ledger is busy (fixture)' };
      const result = ledger.command(cmd.type, cmd.args || {});
      for (const h of listeners) h.onSystem?.({ at: Date.now() });
      return result.ok ? { commandId: cmd.commandId, status: 'applied', outcome: { ...result.outcome, message: result.message } } : { commandId: cmd.commandId, status: 'failed', error: result.error };
    },
    async moveThread() {
      await delay(200);
      return { ok: true };
    },
    async accountHistory() {
      await delay(100);
      return { history: [{ account: 'claude_team', name: 'Claude (Team)', at: Date.now() - 3 * 3_600_000, reason: 'start' }, { account: 'claude_spare', name: 'Claude (Spare)', at: Date.now() - 40 * 60_000, reason: 'limit' }] };
    },
    async routing() {
      await delay(120);
      const options = await this.startWorkOptions();
      return { rules: fixtureRouting, accounts: options.accounts.filter((a) => a.driver === 'claudeAgent'), repos: options.repos.map((r) => r.name), editable: true };
    },
    async saveRouting(body) {
      await delay(200);
      fixtureRouting = { default: body.default, repos: Object.entries(body.repos).map(([repo, accounts]) => ({ repo, accounts })), error: null };
      return { ok: true, rules: fixtureRouting };
    },
    async pauseCommand(action, pauseId) {
      if (!pause?.active) throw Object.assign(new Error('the operator is not paused'), { status: 409 });
      if (pauseId !== pause.id) throw Object.assign(new Error('that pause is no longer the current one'), { status: 409 });
      await delay(300);
      pause = { ...pause, active: false, since: null, waiting: 0, still: false, updatedAt: Date.now() };
      emit('onPause', pause);
      return { accepted: true };
    },
    connect(handlers) {
      listeners.add(handlers);
      setTimeout(() => {
        handlers.onStatus?.(true);
        handlers.onHello?.({ screenId: 'fixture-screen', operatorLive: operator.live });
        handlers.onDashboard?.({ operatorLive: operator.live, windows: [{ id: 'fixture-screen', name: 'this window', role: params.get('role') || 'full' }], liveSceneIds: null, livePrototypes: null });
        handlers.onOperator?.(clone(operator));
        if (draft) handlers.onDraft?.(clone(draft));
        if (pause) handlers.onPause?.(clone(pause));
      }, 0);
      return () => {
        listeners.delete(handlers);
        if (!listeners.size) timers.forEach((t) => (clearInterval(t), clearTimeout(t)));
      };
    },
  };
}
