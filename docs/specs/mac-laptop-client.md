# Mac laptop voice client

## Recommendation and scope

Add an explicit **Connect to an existing Tango** mode to the existing Mac app,
sharing TangoVoice and TangoDeskKit. Produce a lightweight client build without
Node, server entry paths, or a server LaunchAgent. Keep the host build and its
installation procedure intact. Use the existing Tailscale Serve identity path;
do not copy the host's server token to the laptop.

The owner approved the staged plan; each stage requires coordinator review
before the next begins. Stage 1 establishes the remote auth contract. Approval
does not authorize unrelated access-policy changes, installation, or deployment. Start with hold/tap dictation. Enable live mic
only after remote transport and sleep tests pass. The feature sends ordinary
replies to a selected conversation; it is not arbitrary Mac dictation, local
computer control, or a replacement for the server's voice operator.

Source baseline: `b6af7e50`; live-mic behavior inspected separately at `5f7779d6`
(PR #1064, subsequently merged as `f872c430`).

## What works today, and what does not

| Area | Evidence and consequence |
| --- | --- |
| Voice transport | `apps/tango-app/Sources/TangoVoice/VoiceTransport.swift`, `VoiceRequests.socket`: DeskAddress accepts remote HTTPS, appends the API path and converts to WSS. The origin is the base scheme/host/port, without the deployment path. No server process is needed on the client. |
| Reply transport | `apps/tango-ios/TangoDeskKit/Sources/TangoDeskKit/DeskClient.swift`: native JSON POST to `api/desk/commands`, no browser Origin, cookies, or bearer token. Redirects are refused. |
| Target selection | `VoiceTransport.target` reads presentation and item detail sequentially. `VoiceTarget` requires an open, active, replyable conversation. This is the server's shared presentation, not the foreground laptop window. A target is frozen at start and shown in the strip. Another screen can change the shared selection before the next dictation. |
| First run | `PushToTalk.swift`: voice URL starts empty and only probes loopback port 9410 if no preference exists. A laptop has no automatic remote discovery. Settings can accept a remote URL even when the server dashboard is unreachable. The eligible first dictation requests microphone permission; shortcut registration happens at startup. |
| Menu/status | `TangoApp.swift`, Store: defaults to loopback port 9440 and a local server token file. The file is read before each request. A clean laptop fails on the missing token and shows red/server-unreachable, even if remote voice works. |
| API inventory | Store reads `health`, `services`, `maintenance`, `releases`, `resources`; selected logs poll `services/:id/logs?lines=200`. These belong to Tango Server, not the desk. Polling is 5 seconds while visible, 30 seconds otherwise; logs every 3 seconds. Changing the voice URL changes none of these. |
| Server controls | Services start/stop/restart, maintenance, rollback and server settings remain in the UI. They must be absent in client mode, with the API/control objects not instantiated. Repointing the server URL at the desk cannot translate its API or credentials. |
| LaunchAgent | `TangoKit/LaunchAgent.swift`: initialization is inert, but Settings polls launchctl; the login toggle writes/bootstraps the external server job or removes/boots it out. On a bundle without Node, enabling fails. Disabling can still affect an existing local server. Hide controls and gate the underlying calls. |
| Startup migration | `TangoApp.init` unconditionally attempts retirement of an obsolete SMAppService server login item. Client mode must not run that host migration. There is no app-only login toggle today. |
| Build/install | `scripts/build-app.sh` requires a real absolute server entry path and executable Node, copies Node, and writes a server LaunchAgent with host-specific paths. It signs ad hoc. `install-app.py` is a host replacement procedure requiring an existing server installation; it is not laptop first-run provisioning. |

**Verdict:** the voice components are already remote-capable. The stock build and
shell are not a supported client-only product. A stripped executable could use
the voice path, but a normal no-server package cannot be produced with today's
build script, and startup/server UI side effects remain. No such package was
installed or launched during this spike.

## Authorization — security-sensitive

The two APIs have different trust models. Tango Server's APIClient sends a bearer
read from a file. Desk voice and replies instead use the screen service's access
middleware in `apps/screen/server/access.ts`, mounted in `server/app.ts`.

The desk binds loopback by default (`server/main.ts`, SCREEN_HOST). Remote access
must enter through the trusted Serve reverse proxy. Access control trusts proxy
headers, not a cryptographically validated identity supplied by the Swift app:

1. Any Tailscale-Funnel-Request is refused.
2. A request with Tailscale-User-Login or Tailscale-Headers-Info is considered
   proxied. With SCREEN_ALLOWED_LOGINS set, its decoded login must match. A
   tagged device has no user login and fails that allowlist.
3. **An unset/empty allowlist allows all proxied tailnet users** (including the
   no-login branch). This is existing behavior, not an owner-only guarantee.
4. Origin-bearing writes and WebSocket upgrades must match forwarded host and
   protocol. Native JSON command POSTs omit Origin, but still pass identity
   checks; requireJsonPosts enforces JSON for desk writes. Origin is a browser
   defense, not authentication of native clients.
5. `voice.ts` rejects upgrades without Origin, copies handshake headers, and
   calls `app.fetch` on the metadata route before `handleUpgrade`. This re-runs
   middleware and validates voice setup. The internally constructed HTTP URL
   is compatible with HTTPS Origin because forwarded protocol is checked.

A user-owned MacBook whose login is allowed and whose network grant permits the
Serve endpoint should pass both REST and WSS without a new app token. The app
must not fabricate identity headers. A tagged laptop, blocked network grant,
expired/disconnected Tailscale session, incorrect deployment path, or mismatched
Origin will fail. Sharing the tailnet alone is not proof of intended authority.

Tailscale documents that Serve adds user identity headers, omits them for tagged
devices, removes incoming identity headers, and requires backends to remain local
to avoid header spoofing ([Serve identity headers](https://tailscale.com/docs/features/tailscale-serve)).
The app's current loopback trust is deliberate: local callers bypass identity.
Do not expose port 9410 on all interfaces or introduce an untrusted intermediary
that can inject forwarding headers.

### Smallest safe design

Retain Serve + an explicitly verified owner login allowlist + narrow tailnet
network grants + a loopback-only backend. After the feasibility spike, the owner
approved restricting the deployed allowlist to the owner's login. The coordinator
reports verification of owner access through Serve (200), unlisted and tagged
identities (403), and direct local access (200). This supersedes the initial
open-allowlist observation below. No identity values belong in this document.

This authorization is **per login, not per device**: every reachable user-owned
device on that login receives the same desk access. The coordinator confirmed the
intended laptop is untagged and uses that login. The sandbox mounted-app upgrade
tests exercise the real middleware and voice route with a model stub and a proxy
contract double that removes client identity headers before adding authenticated
peer identity. They do not independently certify Tailscale's implementation or
real-device audio. Live policy changes are outside this implementation stage.

Do not add a device token just to duplicate working Serve login authentication.
A per-device Keychain credential is the fallback if tagged devices or device-level
revocation/scopes are required. That is a separate security design: owner-approved
pairing, random credential, hashed server storage, expiry/rotation/revocation,
explicit read/dictation/reply scopes, HTTPS/WSS Authorization headers, no URL or
log tokens, and redirect refusal. It must not inherit the general server admin
bearer or silently authorize decision approvals. User identity via Serve does not
itself provide per-app or per-device authorization; document that limitation.

Forwarding-only requests fail closed: `accessControl` treats any `Forwarded` or
`X-Forwarded-*` header as a proxied request, so a loopback request that carries
forwarding headers but no Tailscale identity headers is refused rather than
passing the configured allowlist. Serve supplies Headers-Info and the backend
remains loopback-only. [PR #1071](https://github.com/your-org/tango/pull/1071)
closed [issue #1067](https://github.com/your-org/tango/issues/1067) and
replaced the documented-gap assertion with rejection coverage.

Any auth changes require the repository's security review and owner approval.
Existing iPhone/native clients and browser origin defenses must remain compatible.

## Safe probe evidence and limits

On 2026-10-22, from the host machine, without changing configuration:

| Probe | Result |
| --- | --- |
| Remote bare-host presentation and dictation metadata GET | 404: deployment prefix is required. |
| Remote deployed-prefix presentation GET | 200, approximately 22 ms time to first byte in one sample. |
| Remote deployed-prefix dictation metadata GET | 200, approximately 15 ms time to first byte in one sample. |
| Loopback equivalents | 200. |
| HTTP/1.1 WebSocket handshake with a deliberately wrong Origin | 403 through the remote proxy and locally. |
| Loopback GET with a fabricated non-owner identity header | 200; does not establish an enforced owner allowlist. |

An initial curl request negotiated HTTP/2 and returned 200 for an attempted
Upgrade; it was only a metadata GET, **not** an accepted WebSocket. Explicit
HTTP/1.1 with WebSocket version/key then verified rejection. No successful live
upgrade was attempted: it can create a provider exchange. No command POST,
microphone capture, reply, settings change or laptop installation was performed.
No response bodies containing conversations were retained.

The existing `apps/screen/test/access.test.ts` is the targeted verification suite
for listed/unlisted users, tagged devices, Funnel, local trust, and upgrade origin
checks. During this spike that suite could not collect because the worktree
lacked the built `@tango/core` entry. Eight isolated assertions against the actual
access middleware passed (allowlisted user, denied user, tagged device, Funnel,
same/wrong/null upgrade origins, and native POST identity). These do not replace
the full mounted-app suite. Stage 1 subsequently built the workspace and passed
the existing 11 access tests plus eleven mounted-app/proxy upgrade tests and nine
voice-route tests. The new suite is `apps/screen/test/voice-access.test.ts`.
A production successful socket, actual MacBook identity probe, and remote audio
quality remain implementation validation gates. Same-host HTTPS timings are not
hotel/cellular latency measurements. Deployment addresses and private evidence
belong in the operator handoff, not this spec.

## Remote latency and failure behavior

Capture is 24 kHz, mono, signed 16-bit PCM: **48,000 bytes/sec (384 kbit/sec)**
before WebSocket/TLS/network overhead. Microphone and sender each bound queued
audio at roughly one second; that is an application bound, not a bound on all OS
network buffers. A slow link fails instead of providing an offline recorder.
There is no audio replay/resume protocol.

A cold start performs two sequential target reads, a WebSocket handshake, and
provider startup before capture. Two remote read round trips are paid even with
a warm socket. Current reads time out at 10 seconds, voice preparation at 15,
and reply POST at 20. Record separate target lookup, socket-ready, first capture,
first transcript, finish-to-final-text, and reply-ack timings before optimizing.

Hotel/cellular NAT may force a relay. Tailscale's [connection-type documentation](https://tailscale.com/docs/reference/connection-types)
describes direct connections as generally lower latency and higher throughput;
measure the actual path rather than promising a particular delay. Captive portal
login and network grants must work before the client can connect. Use no
certificate bypass and never fall back to public plaintext.

PR #1064 keeps the armed socket dormant until `start`; this avoids keeping a
provider exchange open while muted. It pings every 25 seconds with a 10-second
pong deadline, uses a 15-second warm-connect watchdog, retries a failed connection
once before disarming, and disarms after 30 idle minutes, sleep, screen lock or
input-device change. It does not promise seamless network handoff. Muted capture
is discarded; Bluetooth avoidance can leave the microphone cold while keeping
the socket warm. Activation still starts the provider.

For the laptop implementation:

- Preserve explicit arming, default off on launch, disarm on sleep/lock, and no
  automatic rearm on wake. Lid-close normally triggers sleep; do not equate it
  with sleep in clamshell mode. Test both and define expected behavior explicitly.
- Observe network changes, cancel active capture safely, show disconnected state,
  and require a new utterance after recovery. Reconnection must never replay PCM
  or post an incomplete transcript. Keep retries bounded; no reconnect storm.
- Report failures by stage: denied, desk unavailable, voice unavailable, or reply
  outcome unknown. A lost POST response may mean the reply applied; do not claim
  “nothing sent.” Preserve command UUID/target for explicit retry with tested
  server deduplication. Do not add automatic persistent retry in the first release.
- Test late transcript arrival at finish. VoiceSession currently waits for the
  finish send and a three-second undo timer, not an explicit final-transcript
  acknowledgement. The laptop release must establish a finalization contract
  or demonstrate it cannot silently truncate under the supported delay envelope.
- Clearly distinguish desk connectivity from recording, armed-muted, and server
  health. A connected desk alone does not prove that the provider is ready.

## Packaging, first run, and updates

Use one codebase and product with explicit host/client capability at packaging
time. Add a client build option that includes only the Swift app and resources;
no Node, server plist, server path or token requirement. Host distribution retains
its existing bundle and installer. Avoid a forked lighter application's duplicated
voice implementation and divergent fixes.

First run offers **Connect to existing Tango**; the client package only supports
that capability. In a host-capable package, existing valid local registrations
can suggest host mode, but a temporary connection failure must never change modes.
Save mode explicitly. Gate startup migrations and Store construction before they
can touch host state. Do not let client mode promote itself into host mode.

Onboarding asks for the full secure desk base URL, validates its prefix with
read-only requests, and explains Tailscale/network/auth errors. It requests mic
permission only when trying dictation. Menu includes connection state, destination,
voice settings, open remote desk, and quit. Optional launch-at-login launches only
the GUI client using a separate app login mechanism; it never registers the host
server job. Settings and mode migration require isolated-home tests.

For the first trial, distribute a verified versioned client bundle privately,
with a stable signing identity and architecture matching the laptop. Current
builds target macOS 15+ and build for the builder's architecture; confirm laptop
OS/CPU from inventory before packaging (universal or separate builds as needed).
Do not assume the existing ad-hoc signature yields stable microphone consent.
Developer ID signing/notarization and credential use need their own authorized
release procedure.

Updates initially use an explicit downloaded candidate: quit the client, verify
signature/version, preserve a verified previous bundle, replace only the client
bundle, reopen, and verify endpoint/preferences/microphone permission. A client
installer must refuse any target referenced by a server LaunchAgent. Never run
the host install-app.py on the laptop or replace the installed host bundle.
Host server updates do not update the laptop app. Defer automatic updates until
a signed, authenticated update manifest/channel and rollback policy are designed.

## Staged implementation and acceptance

1. **Establish remote contract and authorization.** Review allowlist, loopback
   bind, actual Serve prefix, user-owned laptop identity and network grants.
   Use a sandbox backend to verify successful HTTP/1.1 upgrades through a proxy,
   no/mismatched Origin, denied user, tagged device, Funnel, and spoofed identity.
   Keep auth changes separate and security-reviewed. Exit: documented remote
   authentication outcome, with no weakening of existing clients.
2. **Ship the client shell and package.** Gate host dependencies, migrations and
   controls; implement endpoint onboarding and app-only login. Reuse hold/tap,
   target freeze and undo. Exit: isolated-home startup performs zero server-token,
   launchctl or server mutation operations; client bundle has no Node/plist; host
   regression suites pass. Keep shared presentation behavior explicit for the
   initial trial, with visible destination and undo; an independent laptop target
   picker is a separate product choice, not an accidental behavior change.
3. **Harden remote dictation before live mic.** Add synthetic delayed/lost frame,
   finalization, disconnect and ambiguous POST coverage; then test approved
   scratch conversations from the real laptop on home Wi-Fi and hotspot/remote
   Wi-Fi. Exercise target change, rejected permissions, server restart, VPN loss,
   interrupted reply, sleep/wake, lock and Bluetooth. Exit: no wrong-thread sends,
   lost-final-text sends, duplicate replies, capture after cancel, or silent failure.
   Publish timing distributions and measured network conditions, not only averages.
4. **Enable optional live mic and deliver updates.** Validate dormant socket over
   idle/relay links, bounded retries, explicit rearm after wake, 30-minute idle
   disarm, clamshell behavior, and coexistence with conferencing. Verify candidate
   installation and rollback without touching host services. Exit: documented
   real-device evidence and an approved client distribution path.

## Questions for plan review

- Is the first release's shared open-conversation target acceptable, or must the
  laptop choose a private destination? Recommend retaining the existing behavior
  for the first trial, explicitly labeled, then evaluating a local picker.
- Is the laptop a user-owned Tailscale device with an allowed login? Verify from
  inventory and a real-device probe rather than inferring from host success.
- Does policy require per-device/app scopes or revocation beyond Tailscale access?
  Recommend existing Serve identity if not; Keychain pairing only if it does.
- Which stable signing/distribution route is already authorized for this Mac?
  Inspect existing release setup before requesting credentials or grants.
