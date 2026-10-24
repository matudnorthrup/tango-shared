# Config Examples

This directory is reserved for publishable example packs.

The active runtime does not load these files automatically. Runtime loading is:

1. `config/defaults`
2. `~/.tango/profiles/<profile>/config`
3. env / CLI overrides

Use examples here for:

- starter profile packs
- integration-specific samples
- safe replacements for sanitized private defaults

Until those packs are fully extracted, use `npm run cli -- init` and
`npm run cli -- config migrate` to bootstrap a real profile from the current
working install.
