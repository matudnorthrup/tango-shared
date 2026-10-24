# Tango Voice Operator

`@tango/tango-voice` holds the voice operator: a full-duplex voice assistant that
sits in a Discord voice channel, runs on OpenAI GPT-Live, and hands work to your
Tango agents through the bot's `/voice/turn` bridge. There is no wake word or
close word; you talk to it naturally.

Setup, configuration, voice commands, and troubleshooting live in
[`docs/guides/voice-operator.md`](../../docs/guides/voice-operator.md).

The earlier Discord voice app (Whisper speech-to-text, wake words, classifiers,
Kokoro text-to-speech) has been retired and removed from this package.

## Layout

- `src/live/`: the operator itself (GPT-Live client, Discord audio bridge, agent
  backend, draft and pause modes, Agent Desk and screen clients).
- `src/testing/live-operator-discord.ts`: the Discord entry point. The LaunchAgent
  installed by `scripts/voice-operator/install-launchagent.mjs` runs this file.
- `src/testing/live-operator-{lab,lab-report,playground,screen-smoke,discord-loopback}.ts`:
  offline lab, browser playground, and smoke tools.
- `src/testing/live-operator-tts.ts` (`lab:tts-session`): a scripted spoken session through the
  live audio path (TTS → Opus as Discord sends it → the production operator wiring, real desk),
  with desk writes fenced to named scratch items. It is safe to run while the owner uses the desk:
  `lab-isolation.ts` gives it a screen of its own, so it never holds the director link or the
  operator desk stream and the owner's taps stay with the owner, and the desk fences the scratch
  threads' agents in for the session (`POST /api/desk/lab-fence`). `desk-e2e.ts` (`lab:desk-e2e`) is the read-only
  replay of the router against a desk snapshot. `live-operator-setup.ts`,
  `real-test-agents.ts`, and `simulated-llm-agents.ts` are shared setup for them.
- `test/`: unit tests (Vitest).

## Run

From the repo root:

```bash
node --env-file=.env --import tsx apps/tango-voice/src/testing/live-operator-discord.ts --operator <id>
```

`.env.example` lists the variables the operator reads.

## Check

```bash
npm run typecheck -w @tango/tango-voice
npm run test -w @tango/tango-voice
```
