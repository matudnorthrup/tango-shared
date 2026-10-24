import { MongoClient } from "mongodb";
import type { StateMutationResult, StateService } from "@tango/core";

const ADAPTER_ID = "health-auto-export";
const BODY_COMPOSITION_TITLE = "Current Body Composition";

export interface HealthAutoExportRecord {
  date: Date | string;
  qty: number;
  units?: string | null;
}

export interface HealthAutoExportDataSource {
  listAfter(collection: "weight_body_mass" | "body_fat_percentage", cursor: string | null): Promise<HealthAutoExportRecord[]>;
  close?(): Promise<void>;
}

export interface HealthAutoExportSyncReport {
  status: "ok" | "unavailable";
  scanned: number;
  applied: number;
  skipped: number;
  cursor: string | null;
  error?: string;
}

export class MongoHealthAutoExportDataSource implements HealthAutoExportDataSource {
  private readonly client: MongoClient;
  private readonly databaseName: string;

  constructor(options: { url?: string; databaseName?: string } = {}) {
    this.client = new MongoClient(options.url ?? process.env.TANGO_HEALTH_AUTO_EXPORT_MONGO_URL ?? "mongodb://127.0.0.1:27017", {
      serverSelectionTimeoutMS: 3_000,
      connectTimeoutMS: 3_000,
    });
    this.databaseName = options.databaseName ?? process.env.TANGO_HEALTH_AUTO_EXPORT_DB ?? "health-auto-export";
  }

  async listAfter(collection: "weight_body_mass" | "body_fat_percentage", cursor: string | null): Promise<HealthAutoExportRecord[]> {
    await this.client.connect();
    const filter = cursor ? { date: { $gt: new Date(cursor) } } : {};
    const rows = await this.client.db(this.databaseName).collection(collection)
      .find(filter, { projection: { date: 1, qty: 1, units: 1 } })
      .sort({ date: 1 })
      .limit(1_000)
      .toArray();
    return rows.flatMap((row) => {
      const quantity = numericValue(row.qty);
      if (quantity === null || !(row.date instanceof Date || typeof row.date === "string")) return [];
      return [{ date: row.date, qty: quantity, units: typeof row.units === "string" ? row.units : null }];
    });
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

export class StateHealthAutoExportAdapter {
  constructor(
    private readonly service: StateService,
    private readonly source: HealthAutoExportDataSource = new MongoHealthAutoExportDataSource(),
  ) {}

  async sync(): Promise<HealthAutoExportSyncReport> {
    const cursor = this.service.getAdapterCursor(ADAPTER_ID)?.cursor ?? null;
    try {
      const [weights, bodyFat] = await Promise.all([
        this.source.listAfter("weight_body_mass", cursor),
        this.source.listAfter("body_fat_percentage", cursor),
      ]);
      const observations = [
        ...weights.map((record) => ({ record, field: "weight_lb" as const, value: normalizeWeightLb(record.qty, record.units) })),
        ...bodyFat.map((record) => ({ record, field: "body_fat_pct" as const, value: normalizeBodyFatPercent(record.qty, record.units) })),
      ].map((observation) => ({ ...observation, occurredAt: normalizeDate(observation.record.date) }))
        .filter((observation): observation is typeof observation & { occurredAt: string } => Boolean(observation.occurredAt))
        .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));

      let entityId = this.service.query({ type: "body-composition", includePrivate: true, limit: 1 }).entities[0]?.id;
      let applied = 0;
      let skipped = 0;
      let latestCursor = cursor;
      for (const observation of observations) {
        const result: StateMutationResult = this.service.mutate({
          ...(entityId ? { entityId } : { typeId: "body-composition", title: BODY_COMPOSITION_TITLE }),
          attributes: { [observation.field]: observation.value },
          kind: "observation",
          note: `Imported ${observation.field} observation from Health Auto Export`,
        }, {
          actor: "sync:health-auto-export",
          source: "sync:health-auto-export",
          includePrivate: true,
          occurredAt: observation.occurredAt,
        });
        entityId = result.entity.id;
        if (result.applied) applied += 1;
        else skipped += 1;
        if (!latestCursor || observation.occurredAt > latestCursor) latestCursor = observation.occurredAt;
      }
      this.service.setAdapterCursor(ADAPTER_ID, latestCursor, {
        lastScanned: observations.length,
        lastApplied: applied,
      });
      return { status: "ok", scanned: observations.length, applied, skipped, cursor: latestCursor };
    } catch (error) {
      return {
        status: "unavailable",
        scanned: 0,
        applied: 0,
        skipped: 0,
        cursor,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async close(): Promise<void> {
    await this.source.close?.();
  }
}

export function normalizeWeightLb(quantity: number, units?: string | null): number {
  const normalizedUnits = units?.trim().toLowerCase() ?? "lb";
  if (["kg", "kilogram", "kilograms"].includes(normalizedUnits)) return round(quantity * 2.204_622_621_8, 3);
  if (["g", "gram", "grams"].includes(normalizedUnits)) return round(quantity * 0.002_204_622_621_8, 3);
  return round(quantity, 3);
}

export function normalizeBodyFatPercent(quantity: number, units?: string | null): number {
  const normalizedUnits = units?.trim().toLowerCase() ?? "%";
  return round(["fraction", "ratio"].includes(normalizedUnits) || (normalizedUnits === "" && quantity <= 1) ? quantity * 100 : quantity, 3);
}

function normalizeDate(value: Date | string): string | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function numericValue(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
