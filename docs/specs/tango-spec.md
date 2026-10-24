# Tango Specification

## Purpose

Tango is a multi-surface agent runtime for coordinating named assistants,
workers, schedules, prompts, and durable state across chat and voice surfaces.

## Core Principles

- Separate reusable source code from user-owned config and runtime data.
- Keep configuration declarative and layered.
- Use stable internal IDs for agents, workers, projects, and workflows.
- Prefer generic tool surfaces over one-off handlers.
- Preserve durable conversation and workflow state across restarts.

## Runtime Model

- Repo defaults live in `config/defaults` and `agents/`.
- User overrides live in `~/.tango/profiles/<profile>/config` and
  `~/.tango/profiles/<profile>/prompts`.
- Runtime state lives in `~/.tango/profiles/<profile>/data`, `cache`, and
  `logs`.

## Configuration Layers

1. Repo defaults
2. Profile overrides
3. Environment variables and CLI flags

## Prompt Model

- Base prompts are stored in the repo.
- Persona, private knowledge, and machine-specific prompt additions belong in
  the profile prompt overlay.
- Prompt assembly should remain inspectable with trace tooling.

## Product Surfaces

- Discord runtime
- Voice runtime
- CLI/operator tools
- Deterministic schedulers and handlers

## Non-Goals

- Storing personal credentials, private infrastructure details, or runtime
  artifacts in the repo
- Requiring users to fork tracked source files just to configure their install
