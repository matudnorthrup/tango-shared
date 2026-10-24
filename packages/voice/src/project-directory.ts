import {
  loadProjectConfigs,
  resolveConfigDir,
  type ProjectConfig,
  type ProviderReasoningEffort,
} from "@tango/core";

export interface VoiceProject {
  id: string;
  displayName: string;
  aliases: string[];
  defaultAgentId?: string;
  provider?: {
    default: string;
    model?: string;
    reasoningEffort?: ProviderReasoningEffort;
    fallback?: string[];
  };
}

function normalizeDisplayName(project: ProjectConfig): string {
  const explicit = project.displayName?.trim();
  if (explicit) return explicit;

  return project.id
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part: string) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeAliases(project: ProjectConfig): string[] {
  const seen = new Set<string>();
  const ordered = [project.id, normalizeDisplayName(project), ...(project.aliases ?? [])];
  const aliases: string[] = [];

  for (const value of ordered) {
    const normalized = value.trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    aliases.push(normalized);
  }

  return aliases;
}

function normalizeMatchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreProjectQuery(query: string, project: VoiceProject): number {
  const normalizedQuery = normalizeMatchText(query);
  if (!normalizedQuery) return 0;

  if (normalizeMatchText(project.id) === normalizedQuery) return 500;
  if (normalizeMatchText(project.displayName) === normalizedQuery) return 400;

  for (const alias of project.aliases) {
    const normalizedAlias = normalizeMatchText(alias);
    if (normalizedAlias === normalizedQuery) return 450;
    if (
      normalizedAlias.includes(normalizedQuery) ||
      normalizedQuery.includes(normalizedAlias)
    ) {
      return 250;
    }
  }

  return 0;
}

export function toVoiceProject(project: ProjectConfig): VoiceProject {
  return {
    id: project.id,
    displayName: normalizeDisplayName(project),
    aliases: normalizeAliases(project),
    defaultAgentId: project.defaultAgentId,
    provider: project.provider,
  };
}

export class ProjectDirectory {
  private readonly projects: VoiceProject[];
  private readonly projectsById: Map<string, VoiceProject>;

  constructor(configDir?: string) {
    this.projects = loadProjectConfigs(resolveConfigDir(configDir)).map((project: ProjectConfig) =>
      toVoiceProject(project),
    );
    this.projectsById = new Map(this.projects.map((project) => [project.id, project]));
  }

  listProjects(): VoiceProject[] {
    return [...this.projects];
  }

  getProject(projectId: string | null | undefined): VoiceProject | null {
    if (!projectId) return null;
    return this.projectsById.get(projectId) ?? null;
  }

  resolveProjectQuery(query: string): VoiceProject | null {
    const trimmed = query.trim();
    if (!trimmed) return null;

    let best: { score: number; project: VoiceProject } | null = null;
    for (const project of this.projects) {
      const score = scoreProjectQuery(trimmed, project);
      if (score <= 0) continue;
      if (!best || score > best.score) {
        best = { score, project };
      }
    }

    return best?.project ?? null;
  }
}
