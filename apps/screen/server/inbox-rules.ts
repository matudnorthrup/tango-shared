import * as fs from 'node:fs';
import yaml from 'js-yaml';
import type { InboxItem, InboxStatus } from './inbox-store.js';

// The owner's inbox rules: a YAML file in the profile layer (the repo is
// public), re-read whenever it changes, so rules change without a deploy.
// See apps/screen/inbox-rules.example.yaml.

export type Priority = 'top' | 'high' | 'normal' | 'low' | 'bottom';
const PRIORITY_SCORE: Record<Priority, number> = { top: 100, high: 10, normal: 0, low: -10, bottom: -100 };
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export interface InboxRule {
  name: string;
  match: {
    agent?: string | string[];
    /** Case-insensitive regex over the summary and latest agent text. */
    text?: string;
    /** Case-insensitive regex over the thread title. */
    place?: string;
    status?: InboxStatus | InboxStatus[];
  };
  priority?: Priority;
  /** Weekday name: the item is never urgent except on that day. */
  quiet_until?: string;
  /** "daily": matching agent messages collect into one item per agent per day. */
  group?: 'daily';
  /** Only shown under All. */
  hide?: boolean;
  label?: string;
  /** "report": a recurring report the owner skims; the desk makes it their move only on an explicit ask. */
  kind?: 'report';
}

export interface RuleEffects {
  score: number;
  quiet: boolean;
  hidden: boolean;
  labels: string[];
  rules: string[];
  kind: 'report' | null;
}

interface CompiledRule {
  rule: InboxRule;
  agents: string[] | null;
  text: RegExp | null;
  place: RegExp | null;
  statuses: InboxStatus[] | null;
}

function compile(rule: InboxRule): CompiledRule {
  const list = <T>(value: T | T[] | undefined): T[] | null => (value === undefined ? null : Array.isArray(value) ? value : [value]);
  return {
    rule,
    agents: list(rule.match?.agent)?.map((agent) => agent.toLowerCase()) ?? null,
    text: rule.match?.text ? new RegExp(rule.match.text, 'i') : null,
    place: rule.match?.place ? new RegExp(rule.match.place, 'i') : null,
    statuses: list(rule.match?.status),
  };
}

/** Clones (sierra-ollama) match their persona's rules. */
function baseAgent(agentId: string): string {
  return agentId.toLowerCase().replace(/-ollama$/, '');
}

function matches(compiled: CompiledRule, item: Pick<InboxItem, 'agentId' | 'summary' | 'lastText' | 'place' | 'status'>): boolean {
  if (compiled.agents && !compiled.agents.includes(baseAgent(item.agentId))) return false;
  if (compiled.text && !compiled.text.test(`${item.summary}\n${item.lastText}`)) return false;
  if (compiled.place && !compiled.place.test(item.place ?? '')) return false;
  if (compiled.statuses && !compiled.statuses.includes(item.status)) return false;
  return true;
}

export class InboxRules {
  private compiled: CompiledRule[] = [];
  private mtimeMs = -1;
  error: string | null = null;

  constructor(readonly path: string | null, private readonly now: () => number = Date.now) {}

  /** Changes whenever the file is re-read, so callers can re-apply rule effects to what they hold. */
  version(): number {
    this.refresh();
    return this.mtimeMs;
  }

  /** Re-reads the file if it changed. A bad file keeps the previous rules and reports why. */
  private refresh(): void {
    if (!this.path) return;
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(this.path).mtimeMs;
    } catch {
      if (this.mtimeMs !== 0) this.compiled = [];
      this.mtimeMs = 0;
      this.error = null;
      return;
    }
    if (mtimeMs === this.mtimeMs) return;
    this.mtimeMs = mtimeMs;
    try {
      const parsed = yaml.load(fs.readFileSync(this.path, 'utf8')) as { rules?: InboxRule[] } | null;
      const rules = parsed?.rules ?? [];
      if (!Array.isArray(rules)) throw new Error('`rules` must be a list');
      this.compiled = rules.map((rule, index) => compile({ ...rule, name: rule.name ?? `rule ${index + 1}` }));
      this.error = null;
    } catch (err) {
      this.error = (err as Error).message;
    }
  }

  list(): InboxRule[] {
    this.refresh();
    return this.compiled.map((compiled) => compiled.rule);
  }

  /** The first daily-group rule matching an agent message, if any. */
  groupFor(agentId: string, text: string): InboxRule | null {
    this.refresh();
    const probe = { agentId, summary: '', lastText: text, place: null, status: 'done' as InboxStatus };
    return this.compiled.find((compiled) => compiled.rule.group === 'daily' && matches(compiled, probe))?.rule ?? null;
  }

  /** The kind for a conversation: "report" rules matched on agent and place only (text and status are ignored). */
  kindFor(agentId: string, place: string | null): 'report' | null {
    this.refresh();
    const hit = this.compiled.find((compiled) => compiled.rule.kind === 'report' && (!compiled.agents || compiled.agents.includes(baseAgent(agentId))) && (!compiled.place || compiled.place.test(place ?? '')));
    return hit ? 'report' : null;
  }

  effects(item: Pick<InboxItem, 'agentId' | 'summary' | 'lastText' | 'place' | 'status'>): RuleEffects {
    this.refresh();
    const effects: RuleEffects = { score: 0, quiet: false, hidden: false, labels: [], rules: [], kind: null };
    const today = WEEKDAYS[new Date(this.now()).getDay()];
    for (const compiled of this.compiled) {
      if (!matches(compiled, item)) continue;
      const { rule } = compiled;
      effects.rules.push(rule.name);
      if (rule.priority) effects.score += PRIORITY_SCORE[rule.priority] ?? 0;
      if (rule.quiet_until && rule.quiet_until.toLowerCase() !== today) effects.quiet = true;
      if (rule.hide) effects.hidden = true;
      if (rule.label) effects.labels.push(rule.label);
      if (rule.kind === 'report') effects.kind = 'report';
    }
    return effects;
  }
}
