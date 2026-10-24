# screen

Put things on the owner's screens: browser pages left open around the house
(a tablet, a monitor, a phone) that show what agents stage. Spec:
`docs/specs/agent-desk.md`.

You **stage** scenes. The voice operator decides what is showing: your scene
comes up when the conversation is about you, when the owner asks for it, or
when you mark it urgent. With no voice session, staged scenes wait as tiles on
the screen's dashboard and the owner can tap them.

## When to stage

- The request says a screen is live, or the owner asks to see something
  ("put it on the screen", "show me").
- A visual is genuinely better than words: options to compare, a chart, a
  running total, a screenshot of the step to take, a video to review.
- Not on ordinary text turns where nobody is looking at a screen.

When your scene is staged during a voice turn, keep your spoken reply to the
gist ("Three picks are on the screen; the Sony is my top choice") and let the
screen carry the comparison.

## Actions

| action | inputs | does |
| --- | --- | --- |
| `stage` | `kind`, `body`, `summary` (required), `title`, `slot`, `choices`, `state`, `urgent`, `ttl_minutes` | Stages a scene. Same `slot` replaces your scene in place. |
| `update` | `slot`, `state` and/or `summary` | Changes a live scene's data without re-rendering it. |
| `clear` | `slot`, or `all: true` | Removes a scene, or your whole stage. |
| `list` | — | Screens connected, operator live, what is showing, your scenes. |

`kind`:

- `html` (default): any HTML. A fragment is wrapped in a page; a full document
  keeps its own `<head>`.
- `markdown`: rendered with tables and code.
- `image` / `video`: `body` is an absolute local file path (copied into the
  screen's asset store) or an http(s) URL.
- `url`: shows a web page in a frame. Many sites refuse to be framed; take a
  screenshot and stage it as `image` instead.

The stage result includes `check`: the scene rendered once in headless
Chromium. If `check.errors` is not empty, fix the scene and stage it again.
`check.warnings` covers glanceability (too many words, too tall, hidden
content) and phone layout. Fix those too unless there's a reason not to.
`check.screenshot` is a PNG path you can look at.

## Design

Content is entirely yours. There are no templates; the examples below are
starting points to copy, remix, or ignore.

**A glance, not a document.** The owner sees screens from across the room,
on a wall display, or while scrolling past on a phone. They look at them and
don't read them.

- Lead with the answer: the headline is the finding, the pick, or the
  question you need answered. It isn't the topic.
- Under about 150 words in total. Use labels, numbers and a line or two each.
  Leave out paragraphs, background and methodology.
- One screen, no scrolling on a monitor.
- Nothing behind a click: options sit side by side. Don't use tabs, toggles,
  accordions or carousels. `data-choice` cards for picking are fine.
- Let pictures carry it: photos, screenshots, charts, big numbers.
- When there is more to read (a full write-up, a guide, a long list), put it
  behind one `<a href="…" target="_blank">Full report</a>` link, or send it as
  text in the conversation. Don't put it on the screen.

The stage check measures this. A warning that the scene reads like a
document, is several screens tall, or hides content behind tabs means cut it
down and stage it again in the same slot.

**Make it responsive.** Screens range from a phone (390px wide) to a TV, and the
same scene shows on all of them. Use fluid layouts only:

- Grids: `grid-template-columns: repeat(auto-fit, minmax(min(100%, 16em), 1fr))`
  (cards wrap to one column on a phone).
- Rows of things: `display: flex; flex-wrap: wrap`.
- No fixed pixel widths on containers. Use `max-width` and percentages.
- Wide tables become stacked cards on a phone (pattern below), or at least sit
  in a horizontally scrolling wrapper.

The stage check renders your scene at phone width. Content wider than the screen
is an **error** (fix it and re-stage); a table that scrolls sideways is a
**warning**. `check.phoneScreenshot` shows what the phone sees.

```html
<style>
  /* A comparison table that turns into cards on a phone. */
  @media (max-width: 640px) {
    table, thead, tbody, tr, th, td { display: block; }
    thead { display: none; }
    tr { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); padding: .6em .9em; margin-bottom: .6em; }
    td { border: 0; padding: .15em 0; }
    td::before { content: attr(data-label) ": "; color: var(--muted); }
  }
</style>
<table>
  <thead><tr><th>Speaker</th><th>Screen</th><th>Price</th></tr></thead>
  <tbody>
    <tr><td data-label="Speaker">Brand P DMH-WT6000NEX</td><td data-label="Screen">10.1" floating</td><td data-label="Price">~$1,500</td></tr>
  </tbody>
</table>
```

Every scene gets base styles you can override:

- Big type sized for a glance from across the room (`body` font scales with
  the screen width).
- CSS variables: `--bg --fg --muted --card --line --accent --good --warn --bad
  --radius --font`. `--accent` is your agent's color.
- `.card` (rounded panel) and `.muted` classes.
- Dark by default, light when the device prefers it.
- A phone safety net: images and video shrink to fit, and a table that is still
  too wide scrolls inside itself rather than pushing the whole page sideways.
  It's a net, not a design; the check still warns about it.

Libraries load from `cdn.jsdelivr.net` or `cdnjs.cloudflare.com` (Chart.js,
D3, Leaflet, …). Images can hotlink from the web. Scenes run sandboxed:
`localStorage` and cookies are unavailable.

## The `tango` bridge

Available to every scene's scripts:

- `tango.state` and `tango.onState(fn)`: live data. `fn` runs at load and on
  every `update`.
- `data-choice="<id>"` on any element makes it a tap target; or call
  `tango.choose(id, label)`. List the same options in `choices` so the owner
  can also pick by voice ("the second one").
- `tango.onCommand(fn)`: voice commands such as `next`, `back`, `play`,
  `pause`, for step guides and videos.
- `tango.emit(type, data)`: any other input you want back.

Picks and inputs come back to you as a message in this conversation, or, during
a voice session, as the owner's reply on your task.

## Patterns

- **Board:** a session's running deliverable (a ranking, plan, decision list,
  packing list). Stage it in one slot (`speaker-shortlist`) and re-stage the same
  slot as the owner adds criteria. The screen shows "Updated" and the operator
  keeps it in view.
- **Separate scenes, separate slots:** a deep dive on one pick or a new
  topic gets its own slot, so "put the list back up" still works.
- **Live scene:** stage the chart once with `state`, then `update` only the
  data (a meal logged, a deploy step done). Costs a few tokens per refresh.
- **Poll / A-B:** two to four large `data-choice` cards plus `choices`.
- **Step guide:** one step per view, advanced by `tango.onCommand('next')`, with a
  screenshot of what to tap.
- **Media review:** `video` scenes start muted and paused; the operator sends
  `play` when the owner says they are ready.

## Examples

### Ranked shortlist with picks

```json
{
  "action": "stage",
  "slot": "speaker-shortlist",
  "title": "Speaker shortlist",
  "summary": "Top three double-DIN speakers with wireless Bluetooth under $600",
  "choices": [
    { "id": "a", "label": "Speaker model A" },
    { "id": "b", "label": "Brand P DMH-WT7600NEX" },
    { "id": "c", "label": "Brand K DMX958XR" }
  ],
  "body": "<style>.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,14em),1fr));gap:.8em}.rank{background:var(--accent);color:#000;font-weight:800;border-radius:999px;padding:.1em .6em}.price{font-size:1.4em;font-weight:800}</style><h1>Speaker shortlist</h1><div class=\"grid\"><div class=\"card\" data-choice=\"a\" data-label=\"Speaker model A\"><span class=\"rank\">1</span><h2>Speaker model A</h2><div class=\"price\">$498</div><p class=\"muted\">Best in glare, real volume knob.</p></div><div class=\"card\" data-choice=\"b\" data-label=\"Brand P DMH-WT7600NEX\"><span class=\"rank\">2</span><h2>Brand P DMH-WT7600NEX</h2><div class=\"price\">$579</div><p class=\"muted\">Biggest screen; touch-only volume.</p></div><div class=\"card\" data-choice=\"c\" data-label=\"Brand K DMX958XR\"><span class=\"rank\">3</span><h2>Brand K DMX958XR</h2><div class=\"price\">$549</div><p class=\"muted\">Best sound tuning; dimmer screen.</p></div></div>"
}
```

### Live macro bars

Stage once:

```json
{
  "action": "stage",
  "slot": "macros-today",
  "title": "Macros today",
  "summary": "Calories and macros logged so far today",
  "state": { "totals": { "calories": 1420, "protein": 96 }, "goals": { "calories": 2300, "protein": 180 } },
  "body": "<style>.row{display:grid;grid-template-columns:6em 1fr 8em;gap:.8em;align-items:center;margin:.7em 0}.track{height:1.1em;background:var(--card);border-radius:999px;overflow:hidden}.fill{height:100%;background:var(--accent);transition:width .8s}</style><h1>Today so far</h1><div id=\"bars\"></div><script>tango.onState(function(s){document.getElementById('bars').innerHTML=Object.keys(s.goals).map(function(k){var v=s.totals[k]||0,g=s.goals[k];return '<div class=\"row\"><b>'+k+'</b><div class=\"track\"><div class=\"fill\" style=\"width:'+Math.min(100,v/g*100)+'%\"></div></div><span>'+Math.round(v)+' / '+g+'</span></div>'}).join('')})</script>"
}
```

Then, after the next meal is logged:

```json
{ "action": "update", "slot": "macros-today", "state": { "totals": { "calories": 2010, "protein": 151 } } }
```

### Chart

```html
<h1>Weight, last 30 days</h1>
<canvas id="c"></canvas>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<script>
  tango.onState(function (s) {
    new Chart(document.getElementById('c'), {
      type: 'line',
      data: { labels: s.days, datasets: [{ data: s.weights, borderColor: getComputedStyle(document.documentElement).getPropertyValue('--accent') }] },
      options: { plugins: { legend: { display: false } } }
    });
  });
</script>
```

### Step guide

```html
<div id="step"></div>
<script>
  var steps = tango.state.steps, i = 0;
  function render() {
    var s = steps[i];
    document.getElementById('step').innerHTML =
      '<p class="muted">Step ' + (i + 1) + ' of ' + steps.length + '</p><h1>' + s.text + '</h1>' +
      (s.image ? '<img src="' + s.image + '" style="max-height:60vh;border-radius:16px">' : '');
  }
  tango.onCommand(function (name) {
    if (name === 'next' && i < steps.length - 1) i++;
    if (name === 'back' && i > 0) i--;
    render();
  });
  render();
</script>
```

### Screenshot

```json
{ "action": "stage", "kind": "image", "body": "/abs/path/router-settings.png", "summary": "Where the 5 GHz toggle is in the router settings", "title": "Router: 5 GHz toggle" }
```
