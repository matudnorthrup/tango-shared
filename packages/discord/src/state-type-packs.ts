import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { StateService, StateTypePackConfig } from "@tango/core";

export interface StateTypePackInstallResult {
  packId: string;
  status: "installed" | "skipped" | "failed";
  created: number;
  updated: number;
  error?: string;
}

export interface StateTypePackInstallReport {
  installed: number;
  skipped: number;
  failed: number;
  typesCreated: number;
  typesUpdated: number;
  packs: StateTypePackInstallResult[];
}

/**
 * Install schema-only type packs. Each pack gets an independent SQLite
 * savepoint, so validation or additive-compatibility failures roll back every
 * definition in that pack without preventing other packs from installing.
 */
export function installStateTypePacks(input: {
  service: StateService;
  db: DatabaseSync;
  packs: readonly StateTypePackConfig[];
}): StateTypePackInstallReport {
  const report: StateTypePackInstallReport = {
    installed: 0,
    skipped: 0,
    failed: 0,
    typesCreated: 0,
    typesUpdated: 0,
    packs: [],
  };

  for (const pack of input.packs) {
    if (!pack.enabled) {
      report.skipped += 1;
      report.packs.push({ packId: pack.id, status: "skipped", created: 0, updated: 0 });
      continue;
    }

    const savepoint = `tango_type_pack_${randomUUID().replace(/-/gu, "")}`;
    let created = 0;
    let updated = 0;
    input.db.exec(`SAVEPOINT ${savepoint}`);
    try {
      for (const type of pack.types) {
        const result = input.service.defineType({
          id: type.id,
          displayName: type.displayName,
          description: type.description,
          attributesSchema: type.attributesSchema,
          statuses: type.statuses,
          stalenessPolicy: type.stalenessPolicy,
          digestTemplate: type.digestTemplate,
          bodyFields: type.bodyFields,
          visibility: type.visibility,
          origin: `type-pack:${pack.id}`,
        }, { includePrivate: true });
        if (result.created) created += 1;
        else updated += 1;
      }
      input.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      report.installed += 1;
      report.typesCreated += created;
      report.typesUpdated += updated;
      report.packs.push({ packId: pack.id, status: "installed", created, updated });
    } catch (error) {
      input.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      input.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      report.failed += 1;
      report.packs.push({
        packId: pack.id,
        status: "failed",
        created: 0,
        updated: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return report;
}
