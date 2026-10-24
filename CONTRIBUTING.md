# Contributing

## Development Baseline

- Node 22
- `npm install`
- `cp .env.example .env`

## Project Rules

- Keep reusable behavior in the repo.
- Keep personal config, persona, and private knowledge in the profile layer.
- Keep runtime artifacts out of the repo.
- Add or update tests in the same change when behavior changes.

## Common Commands

- `npm run build`
- `npm test`
- `npm run verify:profile-refactor`
- `npm run cli -- paths`
- `npm run cli -- doctor`

## Config Changes

- Repo-owned defaults live under `config/defaults`.
- User-specific overrides belong under `~/.tango/profiles/<profile>/config`.
- Do not add new secrets, private account identifiers, or machine-local paths
  to tracked defaults.

## Pull Requests

- Keep changes scoped and explain the user-visible effect.
- Call out config migrations or compatibility risks explicitly.
- Include the verification commands you ran.
