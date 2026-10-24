import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import {
  isGeneratedObsidianProjection,
  StateService,
  type StateEntity,
  type StateTypeDefinition,
} from "@tango/core";
import { parseStateBodyPointer } from "./state-body-provider.js";

export interface StateObsidianAdapterOptions {
  service: StateService;
  vaultRoot?: string | null;
  watchIntervalMs?: number;
}

export interface StateObsidianScanReport {
  linked: number;
  mirrored: number;
  ingested: number;
  unchanged: number;
  invalid: number;
  unavailable: number;
}

interface FrontmatterDocument {
  data: Record<string, unknown>;
  body: string;
}

export class StateObsidianAdapter {
  private readonly service: StateService;
  private readonly vaultRoot: string | null;
  private readonly watchIntervalMs: number;
  private readonly watched = new Set<string>();
  private unsubscribe: (() => void) | null = null;

  constructor(options: StateObsidianAdapterOptions) {
    this.service = options.service;
    this.vaultRoot = options.vaultRoot ? path.resolve(options.vaultRoot) : null;
    this.watchIntervalMs = Math.max(250, options.watchIntervalMs ?? 1_000);
  }

  async start(): Promise<StateObsidianScanReport> {
    const report = await this.scan();
    if (!this.vaultRoot || !isDirectory(this.vaultRoot)) return report;
    this.unsubscribe = this.service.onEntityChanged((entity) => this.mirrorEntityById(entity.id));
    this.refreshWatchSet();
    return report;
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const filePath of this.watched) fs.unwatchFile(filePath);
    this.watched.clear();
  }

  async scan(): Promise<StateObsidianScanReport> {
    const report: StateObsidianScanReport = {
      linked: 0,
      mirrored: 0,
      ingested: 0,
      unchanged: 0,
      invalid: 0,
      unavailable: 0,
    };
    const linked = this.service.listLinkedEntities({ includePrivate: true });
    for (const item of linked) {
      if (item.type.bodyFields.length === 0 || !isObsidianPointer(item.entity.bodyPointer)) continue;
      report.linked += 1;
      const outcome = await this.syncLinkedEntity(item.entity, item.type);
      report[outcome] += 1;
    }
    this.refreshWatchSet();
    return report;
  }

  async ingestFile(filePath: string): Promise<"mirrored" | "ingested" | "unchanged" | "invalid" | "unavailable"> {
    const absolute = path.resolve(filePath);
    const item = this.service.listLinkedEntities({ includePrivate: true }).find(({ entity, type }) => {
      if (type.bodyFields.length === 0 || !isObsidianPointer(entity.bodyPointer)) return false;
      try {
        return this.resolveBodyPath(entity.bodyPointer!) === absolute;
      } catch {
        return false;
      }
    });
    return item ? this.syncLinkedEntity(item.entity, item.type) : "unchanged";
  }

  private async syncLinkedEntity(
    entity: StateEntity,
    type: StateTypeDefinition,
  ): Promise<"mirrored" | "ingested" | "unchanged" | "invalid" | "unavailable"> {
    let filePath: string;
    try {
      filePath = this.resolveBodyPath(entity.bodyPointer!);
    } catch (error) {
      this.service.openIssue(entity.id, "body_validation", errorMessage(error), { bodyPointer: entity.bodyPointer });
      return "invalid";
    }
    if (!this.vaultRoot || !isDirectory(this.vaultRoot)) return "unavailable";
    let document: FrontmatterDocument;
    try {
      const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
      if (content !== null && isGeneratedObsidianProjection(content)) return "unchanged";
      document = content !== null ? parseFrontmatter(content) : { data: {}, body: "" };
    } catch (error) {
      this.service.openIssue(entity.id, "body_validation", `Could not parse linked state body: ${errorMessage(error)}`, { bodyPointer: entity.bodyPointer });
      return "invalid";
    }

    const docFields = pickDeclaredFields(document.data, type.bodyFields);
    const headFields = stateFields(entity, type.bodyFields);
    const docHash = StateService.hashBodyFields(docFields);
    const headHash = StateService.hashBodyFields(headFields);

    // A missing baseline is never interpreted as human intent. The database
    // head is canonical, so first contact establishes doc == head.
    if (!entity.bodyFieldsHash) {
      return await this.mirror(entity, type, filePath, document, headFields, headHash);
    }
    if (docHash === entity.bodyFieldsHash) {
      if (headHash === docHash) {
        this.service.resolveIssues(entity.id, "body_validation");
        return "unchanged";
      }
      return await this.mirror(entity, type, filePath, document, headFields, headHash);
    }

    const attributes: Record<string, unknown> = {};
    let status: string | null | undefined;
    for (const field of type.bodyFields) {
      if (field === "status") {
        if (!sameValue(docFields.status, entity.status)) status = docFields.status === null || docFields.status === undefined ? null : String(docFields.status);
      } else if (!sameValue(docFields[field], entity.attributes[field])) {
        attributes[field] = docFields[field];
      }
    }
    if (Object.keys(attributes).length === 0 && status === undefined) {
      this.service.setBodyFieldsHash(entity.id, docHash);
      return "unchanged";
    }
    try {
      const result = this.service.mutate({
        entityId: entity.id,
        ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
        ...(status !== undefined ? { status } : {}),
        kind: status !== undefined ? "status_change" : "update",
        note: "Declared state fields ingested from Obsidian",
      }, {
        actor: "user",
        source: "obsidian",
        includePrivate: true,
      });
      const current = result.entity;
      const currentFields = stateFields(current, type.bodyFields);
      const currentHash = StateService.hashBodyFields(currentFields);
      await this.mirror(current, type, filePath, document, currentFields, currentHash);
      this.service.resolveIssues(entity.id, "body_validation");
      return result.applied ? "ingested" : "unchanged";
    } catch (error) {
      this.service.openIssue(entity.id, "body_validation", `Invalid declared state edit: ${errorMessage(error)}`, {
        bodyPointer: entity.bodyPointer,
        fields: Object.keys(attributes),
      });
      return "invalid";
    }
  }

  private async mirrorEntityById(entityId: string): Promise<void> {
    const item = this.service.listLinkedEntities({ includePrivate: true }).find(({ entity }) => entity.id === entityId);
    if (!item || item.type.bodyFields.length === 0 || !isObsidianPointer(item.entity.bodyPointer)) return;
    let filePath: string;
    try {
      filePath = this.resolveBodyPath(item.entity.bodyPointer!);
      if (!this.vaultRoot || !isDirectory(this.vaultRoot)) throw new Error("Obsidian vault is unavailable");
      const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
      if (content !== null && isGeneratedObsidianProjection(content)) return;
      const document = content !== null ? parseFrontmatter(content) : { data: {}, body: "" };
      const fields = stateFields(item.entity, item.type.bodyFields);
      await this.mirror(item.entity, item.type, filePath, document, fields, StateService.hashBodyFields(fields));
    } catch (error) {
      this.service.openIssue(entityId, "mirror_failed", `State body mirror failed: ${errorMessage(error)}`, { bodyPointer: item.entity.bodyPointer });
    }
  }

  private async mirror(
    entity: StateEntity,
    type: StateTypeDefinition,
    filePath: string,
    document: FrontmatterDocument,
    fields: Record<string, unknown>,
    hash: string,
  ): Promise<"mirrored"> {
    const nextData = { ...document.data };
    for (const field of type.bodyFields) {
      const value = fields[field];
      if (value === undefined || value === null) delete nextData[field];
      else nextData[field] = value;
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, renderFrontmatter({ data: nextData, body: document.body }), "utf8");
    this.service.setBodyFieldsHash(entity.id, hash);
    this.service.resolveIssues(entity.id, "mirror_failed");
    return "mirrored";
  }

  private resolveBodyPath(pointerValue: string): string {
    if (!this.vaultRoot) throw new Error("Obsidian vault is not configured");
    const pointer = parseStateBodyPointer(pointerValue);
    if (pointer.provider !== "obsidian") throw new Error("Only obsidian: bodies are handled by the Obsidian state adapter");
    if (path.isAbsolute(pointer.path) || pointer.path.includes("\0")) throw new Error("Obsidian state body path must be a safe relative path");
    const absolute = path.resolve(this.vaultRoot, pointer.path);
    const relative = path.relative(this.vaultRoot, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Obsidian state body path escapes the configured vault");
    return absolute;
  }

  private refreshWatchSet(): void {
    if (!this.vaultRoot || !isDirectory(this.vaultRoot)) return;
    const desired = new Set<string>();
    for (const { entity, type } of this.service.listLinkedEntities({ includePrivate: true })) {
      if (type.bodyFields.length === 0 || !isObsidianPointer(entity.bodyPointer)) continue;
      try {
        const filePath = this.resolveBodyPath(entity.bodyPointer!);
        desired.add(filePath);
        if (this.watched.has(filePath)) continue;
        fs.watchFile(filePath, { interval: this.watchIntervalMs }, () => {
          void this.ingestFile(filePath).catch((error) => {
            this.service.openIssue(entity.id, "body_validation", `State body watch failed: ${errorMessage(error)}`);
          });
        });
        this.watched.add(filePath);
      } catch (error) {
        this.service.openIssue(entity.id, "body_validation", errorMessage(error), { bodyPointer: entity.bodyPointer });
      }
    }
    for (const filePath of this.watched) {
      if (desired.has(filePath)) continue;
      fs.unwatchFile(filePath);
      this.watched.delete(filePath);
    }
  }
}

export function parseFrontmatter(content: string): FrontmatterDocument {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(content);
  if (!match) return { data: {}, body: content };
  const loaded = yaml.load(match[1] ?? "");
  if (loaded !== null && (typeof loaded !== "object" || Array.isArray(loaded))) {
    throw new Error("Frontmatter must be a YAML mapping");
  }
  return { data: (loaded ?? {}) as Record<string, unknown>, body: match[2] ?? "" };
}

export function renderFrontmatter(document: FrontmatterDocument): string {
  const frontmatter = yaml.dump(document.data, { lineWidth: -1, noRefs: true, sortKeys: false }).trimEnd();
  return `---\n${frontmatter}\n---\n${document.body}`;
}

function stateFields(entity: StateEntity, fields: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(fields.map((field) => [field, field === "status" ? entity.status : entity.attributes[field]]));
}

function pickDeclaredFields(data: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(fields.map((field) => [field, data[field]]));
}

function isObsidianPointer(pointer: string | null): boolean {
  if (!pointer) return false;
  try {
    return parseStateBodyPointer(pointer).provider === "obsidian";
  } catch {
    return false;
  }
}

function isDirectory(value: string): boolean {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
