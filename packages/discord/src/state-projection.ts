import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  StateEntity,
  StateService,
  StateViewConfig,
  StateViewScalar,
  StateViewSectionConfig,
  StateViewSelectorConfig,
  StateViewSortConfig,
} from "@tango/core";

export interface StateProjectionAtlasRecord {
  id: string;
  content: string;
  source: string;
  agentId: string | null;
  importance: number;
  tags?: string[];
  createdAt: string;
  archivedAt?: string | null;
  metadata: Record<string, unknown> | null;
}

export interface StateProjectionRunnerOptions {
  service: StateService;
  views: readonly StateViewConfig[];
  /** Explicit output root. The runner never discovers or defaults to a live vault. */
  outputRoot: string;
  atlasRecords?: (root: StateEntity) => readonly StateProjectionAtlasRecord[];
  now?: () => Date;
}

export interface StateProjectionFileResult {
  viewId: string;
  rootEntityId: string;
  filePath: string;
  status: "written" | "unchanged";
}

export interface StateProjectionReport {
  views: number;
  roots: number;
  written: number;
  unchanged: number;
  removed: number;
  errors: Array<{ viewId: string; error: string }>;
  files: StateProjectionFileResult[];
}

export interface StateProjectionViewResult {
  files: StateProjectionFileResult[];
  removed: number;
}

type ProjectionRecord = Record<string, unknown>;

export class StateProjectionRunner {
  private readonly outputRoot: string;
  private readonly now: () => Date;

  constructor(private readonly options: StateProjectionRunnerOptions) {
    const outputRoot = options.outputRoot.trim();
    if (!outputRoot) throw new Error("State projection outputRoot must be explicitly configured");
    this.outputRoot = path.resolve(outputRoot);
    this.now = options.now ?? (() => new Date());
  }

  run(): StateProjectionReport {
    const report: StateProjectionReport = {
      views: 0,
      roots: 0,
      written: 0,
      unchanged: 0,
      removed: 0,
      errors: [],
      files: [],
    };
    for (const view of this.options.views.filter((candidate) => candidate.enabled)) {
      report.views += 1;
      try {
        const result = this.renderView(view);
        report.roots += result.files.length;
        report.files.push(...result.files);
        report.written += result.files.filter((file) => file.status === "written").length;
        report.unchanged += result.files.filter((file) => file.status === "unchanged").length;
        report.removed += result.removed;
      } catch (error) {
        report.errors.push({ viewId: view.id, error: errorMessage(error) });
      }
    }
    return report;
  }

  renderView(view: StateViewConfig): StateProjectionViewResult {
    const roots = this.selectState(view.forEach, null);
    const destinations = new Map<string, StateEntity>();

    for (const root of roots) {
      const filePath = this.resolveOutputPath(renderTemplate(view.outputPath, { root: stateRecord(root) }));
      const collision = destinations.get(filePath);
      if (collision && collision.id !== root.id) {
        throw new Error(
          `State view '${view.id}' maps roots '${collision.id}' and '${root.id}' to the same output path`,
        );
      }
      destinations.set(filePath, root);
    }

    const files = [...destinations.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([filePath, root]) => {
        const atlasRecords = view.sections.some((section) => section.source === "atlas")
          ? (this.options.atlasRecords?.(root) ?? [])
          : [];
        const content = this.renderDocument(view, root, atlasRecords);
        const status = writeProjectionAtomically(filePath, content, view.id, root.id);
        return { viewId: view.id, rootEntityId: root.id, filePath, status };
      });
    // Prune only after every destination rendered successfully. A collision,
    // invalid path, or failed write above leaves prior projections untouched.
    const removed = pruneStaleProjectionFiles(
      this.outputRoot,
      view.id,
      new Set(destinations.keys()),
    );
    return { files, removed };
  }

  private renderDocument(
    view: StateViewConfig,
    root: StateEntity,
    atlasRecords: readonly StateProjectionAtlasRecord[],
  ): string {
    const rootRecord = stateRecord(root);
    const title = renderTemplate(view.titleTemplate, { root: rootRecord }) || root.title;
    const sectionBlocks = view.sections.map((section) => {
      const records = section.source === "atlas"
        ? this.selectRecords(atlasRecords.map(atlasRecord), section.selector, rootRecord)
        : this.selectState(section.selector ?? {}, root).map(stateRecord);
      const sorted = sortRecords(records, section.sort ?? []);
      const limited = sorted.slice(0, section.limit ?? 500);
      const items = limited.map((record) => renderTemplate(section.itemTemplate, {
        root: rootRecord,
        ...(section.source === "atlas" ? { memory: record } : { entity: record }),
      }));
      const body = items.length > 0 ? items.join("\n") : (section.emptyText ?? "_None._");
      return `## ${singleLine(section.heading)}\n\n${body}`;
    });
    const generatedAt = this.now().toISOString();
    const contentHash = createHash("sha256")
      .update([title, ...sectionBlocks].join("\n\n"))
      .digest("hex");
    return [
      "---",
      `tango_view: ${yamlString(view.id)}`,
      `tango_root_entity_id: ${yamlString(root.id)}`,
      `generated_at: ${yamlString(generatedAt)}`,
      "read_only_projection: true",
      "source_kind: generated",
      `projection_content_hash: ${yamlString(contentHash)}`,
      "---",
      `# ${singleLine(title)}`,
      "",
      ...sectionBlocks.flatMap((block) => [block, ""]),
    ].join("\n").trimEnd() + "\n";
  }

  private selectState(selector: StateViewSelectorConfig, root: StateEntity | null): StateEntity[] {
    const typeIds = selector.types && selector.types.length > 0 ? selector.types : [null];
    const records = typeIds.flatMap((typeId) => this.options.service.query({
      ...(typeId ? { type: typeId } : {}),
      includeArchived: true,
      includePrivate: true,
      includeRelations: true,
      includeReferences: true,
      limit: 500,
    }).entities);
    const deduped = [...new Map(records.map((record) => [record.id, record])).values()];
    const selected = this.selectRecords(deduped.map(stateRecord), selector, root ? stateRecord(root) : null);
    const ids = new Set(selected.map((record) => String(record.id)));
    return deduped.filter((record) => ids.has(record.id)).sort((left, right) => left.id.localeCompare(right.id));
  }

  private selectRecords(
    records: readonly ProjectionRecord[],
    selector: StateViewSelectorConfig | undefined,
    root: ProjectionRecord | null,
  ): ProjectionRecord[] {
    if (!selector) return [...records];
    const types = new Set(selector.types ?? []);
    const statuses = new Set(selector.statuses ?? []);
    return records.filter((record) => {
      if (!selector.includeArchived && getPath(record, "archived_at") != null) return false;
      if (types.size > 0 && !types.has(String(getPath(record, "type_id") ?? ""))) return false;
      if (statuses.size > 0 && !statuses.has(String(getPath(record, "status") ?? ""))) return false;
      for (const [field, expected] of Object.entries(selector.where ?? {})) {
        const resolved = resolveSelectorValue(expected, root);
        if (!sameValue(getPath(record, field), resolved)) return false;
      }
      if (selector.relation) {
        const relations = getPath(record, "relations");
        if (!Array.isArray(relations) || !relations.some((relation) => {
          if (!isRecord(relation)) return false;
          if (selector.relation?.kind && getPath(relation, "kind") !== selector.relation.kind) return false;
          if (selector.relation?.targetEntityId !== undefined) {
            const target = resolveSelectorValue(selector.relation.targetEntityId, root);
            if (!sameValue(getPath(relation, "target_entity_id"), target)) return false;
          }
          return true;
        })) return false;
      }
      if (selector.referenceRoles && selector.referenceRoles.length > 0) {
        const roles = new Set(selector.referenceRoles);
        const references = getPath(record, "references");
        if (!Array.isArray(references) || !references.some((reference) => (
          isRecord(reference) && roles.has(String(getPath(reference, "role") ?? ""))
        ))) return false;
      }
      return true;
    });
  }

  private resolveOutputPath(renderedPath: string): string {
    const relativePath = renderedPath.trim().replace(/\\/gu, "/");
    if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes("\0")) {
      throw new Error(`State projection output path must be a safe relative path: '${renderedPath}'`);
    }
    if (![".md", ".markdown"].includes(path.extname(relativePath).toLowerCase())) {
      throw new Error(`State projection output path must end in .md or .markdown: '${renderedPath}'`);
    }
    const target = path.resolve(this.outputRoot, relativePath);
    const relative = path.relative(this.outputRoot, target);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`State projection output path escapes the configured root: '${renderedPath}'`);
    }
    assertNoSymlinkAncestors(this.outputRoot, target);
    return target;
  }
}

function stateRecord(entity: StateEntity): ProjectionRecord {
  const raw = entity as unknown as Record<string, unknown>;
  return {
    ...raw,
    id: entity.id,
    typeId: entity.typeId,
    type_id: entity.typeId,
    bodyPointer: entity.bodyPointer,
    body_pointer: entity.bodyPointer,
    ownerAgentId: entity.ownerAgentId,
    owner_agent_id: entity.ownerAgentId,
    ownerUserId: entity.ownerUserId,
    owner_user_id: entity.ownerUserId,
    lastEventAt: entity.lastEventAt,
    last_event_at: entity.lastEventAt,
    staleAfter: entity.staleAfter,
    stale_after: entity.staleAfter,
    createdAt: entity.createdAt,
    created_at: entity.createdAt,
    updatedAt: entity.updatedAt,
    updated_at: entity.updatedAt,
    archivedAt: entity.archivedAt,
    archived_at: entity.archivedAt,
    projectEntityId: raw.projectEntityId ?? raw.project_entity_id ?? null,
    project_entity_id: raw.projectEntityId ?? raw.project_entity_id ?? null,
  };
}

function atlasRecord(record: StateProjectionAtlasRecord): ProjectionRecord {
  return {
    ...record,
    agent_id: record.agentId,
    created_at: record.createdAt,
    archived_at: record.archivedAt ?? null,
    metadata: record.metadata ?? {},
  };
}

function resolveSelectorValue(value: StateViewScalar, root: ProjectionRecord | null): unknown {
  if (typeof value !== "string" || !value.startsWith("$root.")) return value;
  if (!root) throw new Error(`Root reference '${value}' cannot be used in a root selector`);
  return getPath(root, value.slice("$root.".length));
}

function sortRecords(records: readonly ProjectionRecord[], sorts: readonly StateViewSortConfig[]): ProjectionRecord[] {
  const stable = [...records];
  stable.sort((left, right) => {
    for (const sort of sorts) {
      const comparison = compareValues(getPath(left, sort.field), getPath(right, sort.field));
      if (comparison !== 0) return sort.direction === "desc" ? -comparison : comparison;
    }
    return String(left.id ?? "").localeCompare(String(right.id ?? ""));
  });
  return stable;
}

function compareValues(left: unknown, right: unknown): number {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  if (typeof left === "boolean" && typeof right === "boolean") return Number(left) - Number(right);
  return String(left).localeCompare(String(right));
}

function renderTemplate(template: string, context: Record<string, ProjectionRecord>): string {
  return template.replace(/\{([a-zA-Z0-9_.-]+)\}/gu, (_match, token: string) => {
    const [scope, ...rest] = token.split(".");
    const record = scope ? context[scope] : undefined;
    if (!record || rest.length === 0) return "";
    return displayValue(getPath(record, rest.join(".")));
  });
}

function getPath(record: ProjectionRecord, dottedPath: string): unknown {
  let current: unknown = record;
  for (const rawSegment of dottedPath.split(".")) {
    if (!isRecord(current)) return undefined;
    const segment = Object.hasOwn(current, rawSegment)
      ? rawSegment
      : snakeToCamel(rawSegment);
    current = current[segment];
  }
  return current;
}

function snakeToCamel(value: string): string {
  return value.replace(/_([a-z])/gu, (_match, character: string) => character.toUpperCase());
}

function displayValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return singleLine(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return stableStringify(value);
}

function singleLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "";
}

function sameValue(left: unknown, right: unknown): boolean {
  return stableStringify(left ?? null) === stableStringify(right ?? null);
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function writeProjectionAtomically(
  filePath: string,
  content: string,
  viewId: string,
  rootEntityId: string,
): "written" | "unchanged" {
  let existing: string | null = null;
  try {
    existing = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
  if (existing !== null) {
    const metadata = projectionMetadata(existing);
    if (!metadata) {
      throw new Error(`Refusing to overwrite non-projection Markdown at '${filePath}'`);
    }
    if (metadata.viewId !== viewId || metadata.rootEntityId !== rootEntityId) {
      throw new Error(`Refusing to overwrite projection owned by another view/root at '${filePath}'`);
    }
    if (withoutGeneratedAt(existing) === withoutGeneratedAt(content)) return "unchanged";
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(tempPath, content, { encoding: "utf8", flag: "wx" });
    fs.renameSync(tempPath, filePath);
  } finally {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Best-effort cleanup after a failed atomic rename/write.
    }
  }
  return "written";
}

function projectionMetadata(content: string): { viewId: string; rootEntityId: string } | null {
  if (!/^read_only_projection:\s*true\s*$/imu.test(content)) return null;
  const viewId = parseYamlString(/^tango_view:\s*(.+?)\s*$/imu.exec(content)?.[1]);
  const rootEntityId = parseYamlString(/^tango_root_entity_id:\s*(.+?)\s*$/imu.exec(content)?.[1]);
  return viewId && rootEntityId ? { viewId, rootEntityId } : null;
}

function pruneStaleProjectionFiles(
  outputRoot: string,
  viewId: string,
  liveDestinations: ReadonlySet<string>,
): number {
  if (!isDirectory(outputRoot)) return 0;
  let removed = 0;
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      // Never follow links while discovering deletion candidates. The explicit
      // root is trusted, but every descendant remains inside that boundary.
      if (entry.isSymbolicLink()) continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      if (!entry.isFile() || ![".md", ".markdown"].includes(path.extname(entry.name).toLowerCase())) {
        continue;
      }
      const absolute = path.resolve(entryPath);
      if (liveDestinations.has(absolute)) continue;
      const metadata = projectionMetadata(fs.readFileSync(absolute, "utf8"));
      if (!metadata || metadata.viewId !== viewId) continue;
      fs.unlinkSync(absolute);
      removed += 1;
    }
  };
  visit(outputRoot);
  return removed;
}

function parseYamlString(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return value.replace(/^['"]|['"]$/gu, "").trim() || null;
  }
}

function withoutGeneratedAt(content: string): string {
  return content.replace(/^generated_at:\s*.+$/imu, "generated_at: <stable>");
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isDirectory(value: string): boolean {
  try {
    // lstat keeps pruning from traversing an output root that is itself a
    // symbolic link. Descendant links are skipped by the directory walk.
    return fs.lstatSync(value).isDirectory();
  } catch {
    return false;
  }
}

function assertNoSymlinkAncestors(outputRoot: string, target: string): void {
  const relativeParent = path.relative(outputRoot, path.dirname(target));
  let current = outputRoot;
  for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error(`State projection output path crosses a symbolic-link directory: '${current}'`);
      }
    } catch (error) {
      if (isMissingFileError(error)) return;
      throw error;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
