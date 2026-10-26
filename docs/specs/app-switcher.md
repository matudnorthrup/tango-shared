# One Tango: app switcher and voice in every app

Status: draft for review (2026-10-23)

## Goal

Tango Lift, Tango Food, Kilo, Tango Usage, Tango State and the desk are separate
web apps on one tailnet host, each mounted at its own path. The only thing
linking them is the card page in `apps/home`. On the phone this means a
different bookmark per app. The iPhone app only shows the desk.

This spec makes them read as one Tango:

1. **One app list** that the server publishes and every surface reads.
2. **A switcher behind the Tango logo/name at the top left** of every app. Tap
   it and a menu lists the other apps. The iPhone app uses the same switcher,
   so all of Tango opens in one native app.
3. **Voice in every app**: the desk's voice controls (dictation to an agent and
   spoken navigation) are available from any app's header.

Non-goals: merging the apps' databases or servers, sharing data across systems
(a later "Today" view), and native screens for any system. Each app stays its
own process, port and store.

## 1. App list

### Source

Repo defaults in `config/defaults/apps.yaml`, overridden by the profile's
`config/apps.yaml` (the usual defaults-plus-profile overlay, so a profile can
reorder, hide or add apps):

```yaml
apps:
  - id: desk
    name: Tango Desk
    path: /tango-screen/
    icon: desk          # a name from the shared icon set, or an image path
    accent: "#..."
  - id: lift
    name: Tango Lift
    path: /tango-workout/
    icon: lift
    accent: "#..."
    agent: malibu       # optional: who voice dictation in this app talks to
  - id: food
    name: Tango Food
    path: /tango-food/
    icon: food
    agent: malibu
  - id: kilo
    name: Kilo
    path: /kilo/
    icon: kilo
    agent: kilo
  - id: usage
    name: Tango Usage
    path: /tango-usage/
  - id: state
    name: Tango State
    path: /tango-state/
```

`path` must be a same-origin path (it starts with `/`, with no scheme or host).
Anything else fails validation and is left out of the list with one log line.
`hidden: true` keeps an app out of the switcher but leaves its route mounted.

### Serving

`apps/home/server.mjs` serves the resolved list at `GET /apps.json` (no-store)
and renders `index.html`'s cards from it, replacing the hand-written
`<a class="site">` blocks. "Adding a site" in `apps/home/README.md` becomes
"mount the path and add an entry". The home server is the one process every
app already sits beside at the tailnet root, so it is the natural owner.
`/apps.json` carries only names, paths, icons, accents and agent ids, and the
tailnet stays the front door, so it needs no extra access control.

## 2. Switcher

### Shared element

Apps use React (Lift, Food, Usage), Preact (desk) and plain HTML (Kilo), so the
switcher is a framework-free custom element served by the home server:

```html
<script type="module" src="/shared/tango-switcher.js"></script>
<tango-switcher current="food">Tango Food</tango-switcher>
```

- The element's content is the existing brand text. It becomes a button with a
  small chevron. Each app keeps its own type style; the element only adds the
  button behavior and the menu.
- Tap: fetch `/apps.json` (cached for the page's lifetime, refreshed on open
  if older than 5 minutes) and show the menu: icon, name, a check on
  `current`. Selecting an app navigates the same tab to its `path`.
- Phone width (the desk's `PHONE` breakpoint): a bottom sheet. Wider: an
  anchored dropdown. Escape, an outside tap or a selection closes it. Arrow
  keys move through items; focus returns to the button on close.
- If `/apps.json` fails, the menu shows a single "Tango home" item linking to
  `/`, so it never comes up empty.
- Styling uses CSS custom properties (`--tango-switcher-bg`, `-fg`, `-accent`)
  with light/dark defaults, so each app can tint it without forking it.

### Placement per app

| App | Today | Change |
|---|---|---|
| Food (`apps/food-ui/src/App.tsx`) | `<span className="brand">Tango Food</span>` | wrap in `<tango-switcher current="food">` |
| Usage (`apps/usage-ui/src/App.tsx`) | brand is a link back to home | replace the link with the switcher (home is in the menu) |
| Lift (`apps/workout-ui`) | header brand | wrap in the switcher; leave the athlete chip where it is |
| Kilo (`apps/kilo-ledger/src/public/index.html`) | `<div class="brand"><h1>Kilo</h1>` | wrap the heading |
| State (`/tango-state`; its UI isn't in this repo's `apps/`) | header brand | wrap where its UI lives; if it's outside this repo, list it in the switcher and defer its header to a follow-up |
| Desk, wide (`desk/next/app.js`, `nx-brand` in the sidebar) | "Tango Desk" text | becomes the switcher trigger, using the desk's own menu component for visual consistency |
| Desk, phone (`Breadcrumb`, `phone` branch) | empty `<span class="nx-ib">` when there is no back button | a Tango logo button that opens the switcher sheet; when there is a back button, back keeps the spot |

The desk renders its own menu with the same `/apps.json` data, not the custom
element, because it already has a menu and sheet system its tests cover.
Behavior must match the element's.

A React wrapper is not needed: React 19 renders custom elements directly. Add a
`tango-switcher` entry to each React app's JSX intrinsic-element types.

## 3. iPhone app

The iPhone app already loads the desk in one `WKWebView`. Today
`DeskAddress.contains` allows only URLs under the desk's base path, so a
switcher link to `/tango-food/` would open Safari.

- `DeskAddress` gains the set of app paths. After the first load (and on each
  foreground), the shell fetches `<origin>/apps.json` and keeps the last good
  copy in UserDefaults. A URL is in-app if it shares the desk's origin and its
  path is under the desk base or any listed app path. Everything else still
  opens in Safari.
- No native tab bar and no native chrome: navigation happens through the web
  switcher in each app's header. Back (swipe from the edge) uses the web view's
  history.
- The microphone policy is unchanged. It already allows capture from the
  desk's origin (scheme, host, port), and every app shares that origin, so voice
  in another app needs no new grant. A foreign origin is still denied.
- Pull-to-refresh, the unreachable/retry UI and decision-notification opens keep
  working from any app. A `tango://decision/D-n` open always loads the desk.
- `TangoDeskKit` tests: `contains` for listed and unlisted paths, a
  prefix-collision case (`/tango-food` vs `/tango-foodx`), a different port or
  host, and a malformed `apps.json` keeping the last good list.

The app keeps its name and icon for now; renaming "Tango Desk" to "Tango" on
the home screen is a separate, owner-facing choice.

## 4. Voice in every app

The desk has two voice paths today:

- **Dictation to a conversation** (`desk/voice-session.js`): speak, it
  transcribes, and it sends as a reply to the open conversation (with an
  optional spoken reply).
- **Navigator** (`desk/navigator.js`, `server/desk/navigator-*.ts`): "go to …"
  phrases resolve against a catalog the open desk window publishes
  (`context.choices`). The server returns a ticket, and the window executes the
  chosen action.

Both run on the desk server and are reached at `/tango-screen/api/desk/...`.
Every app shares that origin, and the desk's owner check uses the tailnet
identity headers on every request, so another app's page can call them without
new authentication.

### 4a. "Switch to Food" from anywhere in the desk (first)

Add one navigator choice per listed app, `{op: 'app', id}`, labelled with the
app's name, to the desk window's context. Executing it navigates to the app's
path. `commandCandidate` already accepts "go to / switch to / take me to …".
This is small and makes voice the second way into the switcher.

### 4b. A voice button in every app's header (second)

A second shared element, `<tango-voice app="food">`, served next to the
switcher and placed at the top right of each header:

- Tap to talk. It reuses `VoiceSession` and the desk's dictation transport
  (moved to `/shared/` or re-exported from the desk's static path; no copy).
- Navigation phrases go to the navigator as in 4a, so "go to Lift" works from
  Kilo.
- Anything else is dictation to that app's `agent` from the app list, sent to
  that agent's default conversation through the desk's existing reply
  path. For example: in Lift, "log three sets of bench at 185" goes to Malibu,
  who already writes it with `workout_sql`. The app's live refresh shows the
  result. Apps without an `agent` show no voice button.
- The reply caption appears in the element (the same `Caption` treatment as the
  desk's phone header), and the spoken reply plays when voice focus is on.
- Only one voice owner at a time per page (`voice-owner.js` semantics).

Out of scope here: page-aware commands inside an app ("open last Tuesday's
workout"), which would need each app to publish its own navigator catalog.
That's a later extension of the same `choices` contract.

## Delivery

Four PRs, in order, each shippable alone:

1. App list + home page from it + `/shared/tango-switcher.js` + switcher in
   Food, Usage, Lift, Kilo, State.
2. Desk switcher (sidebar brand and phone logo).
3. iPhone app: in-app navigation for listed apps.
4. Voice: 4a, then 4b.

## Verification

- Home: `/apps.json` matches the merged defaults and profile. A bad `path`
  is dropped and logged. The home page renders the same cards as before.
- Switcher: from each app, open the menu, select every other app, and land on
  it. Check keyboard navigation and Escape. Make `/apps.json` fail and check
  the menu falls back to home. Check phone and desktop widths with agent-browser
  screenshots of each app with the menu open.
- Desk: unit tests for the phone logo/back precedence and the navigator's app
  choices. Browser check on the sandbox test desk.
- iPhone: `TangoDeskKit` tests above. A Simulator UI test that opens the
  switcher, selects Food, and confirms the page loads in-app, not in Safari.
  Voice capture in Food passes the microphone policy.
- Voice: "switch to Kilo" from the desk and from Lift. Dictation from Lift
  reaches Malibu's default conversation and the reply caption shows.
