#!/usr/bin/env node
// Prepare explicit profile overrides. Dry run unless --apply is passed.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import yaml from 'js-yaml';
import { configureTodoistAgent } from './lib/todoist-agent-config.mjs';
function arg(name) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }
const baseDir = arg('--base-dir');
const profileDir = arg('--profile-dir');
const ids = arg('--agents')?.split(',');
const coordinator = arg('--coordinator');
if (!baseDir || !profileDir || !ids?.length || !coordinator) throw new Error('Usage: --base-dir <repo/config/v2/agents> --profile-dir <profile/config/v2/agents> --agents <ids> --coordinator <id> [--apply]');
if (resolve(baseDir) === resolve(profileDir)) throw new Error('Base and private profile directories must differ');
if (!ids.includes(coordinator)) throw new Error('Coordinator must be included in the explicitly selected agents');
if (!ids.every(id => /^[a-z0-9][a-z0-9-]*$/.test(id))) throw new Error('Agent IDs must be concrete IDs, never wildcards or paths');
const planned = [];
for (const id of new Set(ids)) {
  const base = yaml.load(readFileSync(join(baseDir, `${id}.yaml`), 'utf8'));
  const file = join(profileDir, `${id}.yaml`);
  const override = existsSync(file) ? yaml.load(readFileSync(file, 'utf8')) : { id };
  if (base.id !== id || override.id !== id) throw new Error('Agent ID mismatch');
  if ((override.enabled ?? base.enabled) === false) throw new Error(`Agent ${id} is disabled; this installer does not activate agents`);
  const result = configureTodoistAgent(base, override, { coordinator, isCoordinator: id === coordinator || id === coordinator.replace(/-ollama$/, '') });
  planned.push({ id, file, content: yaml.dump(result, { lineWidth: -1, noRefs: true }) });
}
// All plans validate before any write. No credentials are created or copied.
for (const { id, file, content } of planned) {
  if (process.argv.includes('--apply')) writeFileSync(file, content, { mode: 0o600 });
  console.log(`${process.argv.includes('--apply') ? 'configured' : 'would configure'} ${id}`);
}
