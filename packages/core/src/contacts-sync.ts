/**
 * Contacts Sync — Exports macOS Contacts (AddressBook) to a JSON file
 * for use by the iMessage listener's contact resolution.
 *
 * Reads all AddressBook source databases, deduplicates by name,
 * and writes a flat JSON array of { name, phones[], emails[] }.
 *
 * Can run standalone (node contacts-sync.js <output-path>) or as a
 * deterministic scheduler handler ("contacts-sync").
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import type { DeterministicHandler, DeterministicResult } from "./scheduler/types.js";

export interface ContactRecord {
  name: string;
  phones: string[];
  emails: string[];
  organization?: string;
}

interface RawRow {
  first_name: string | null;
  last_name: string | null;
  organization: string | null;
  phone: string | null;
  email: string | null;
}

const ADDRESSBOOK_BASE = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "AddressBook",
);

function findSourceDatabases(): string[] {
  const sourcesDir = path.join(ADDRESSBOOK_BASE, "Sources");
  const paths: string[] = [];

  try {
    const entries = fs.readdirSync(sourcesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dbPath = path.join(sourcesDir, entry.name, "AddressBook-v22.abcddb");
      if (fs.existsSync(dbPath)) {
        paths.push(dbPath);
      }
    }
  } catch {
    // Sources dir may not exist
  }

  // Also check the main aggregated database
  const mainDb = path.join(ADDRESSBOOK_BASE, "AddressBook-v22.abcddb");
  if (fs.existsSync(mainDb) && !paths.includes(mainDb)) {
    paths.push(mainDb);
  }

  return paths;
}

function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  const clean = digits.replace(/\D/g, "");
  if (clean.length === 10) return `+1${clean}`;
  if (clean.length === 11 && clean.startsWith("1")) return `+${clean}`;
  return clean;
}

function extractContactsFromDb(dbPath: string): Map<string, ContactRecord> {
  const contacts = new Map<string, ContactRecord>();
  let db: DatabaseSync;

  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return contacts;
  }

  try {
    const query = `
      SELECT
        r.ZFIRSTNAME  AS first_name,
        r.ZLASTNAME   AS last_name,
        r.ZORGANIZATION AS organization,
        p.ZFULLNUMBER AS phone,
        e.ZADDRESS    AS email
      FROM ZABCDRECORD r
      LEFT JOIN ZABCDPHONENUMBER p ON p.ZOWNER = r.Z_PK
      LEFT JOIN ZABCDEMAILADDRESS e ON e.ZOWNER = r.Z_PK
      WHERE r.ZFIRSTNAME IS NOT NULL OR r.ZLASTNAME IS NOT NULL
    `;

    const rows = db.prepare(query).all() as unknown as RawRow[];

    for (const row of rows) {
      const first = row.first_name?.trim() ?? "";
      const last = row.last_name?.trim() ?? "";
      const name = [first, last].filter(Boolean).join(" ");
      if (!name) continue;

      const key = name.toLowerCase();
      let contact = contacts.get(key);
      if (!contact) {
        contact = {
          name,
          phones: [],
          emails: [],
          ...(row.organization?.trim() ? { organization: row.organization.trim() } : {}),
        };
        contacts.set(key, contact);
      }

      if (row.phone?.trim()) {
        const normalized = normalizePhone(row.phone.trim());
        if (normalized && !contact.phones.includes(normalized)) {
          contact.phones.push(normalized);
        }
      }

      if (row.email?.trim()) {
        const email = row.email.trim().toLowerCase();
        if (!contact.emails.includes(email)) {
          contact.emails.push(email);
        }
      }
    }
  } finally {
    db.close();
  }

  return contacts;
}

export function syncContacts(): ContactRecord[] {
  const dbPaths = findSourceDatabases();
  const merged = new Map<string, ContactRecord>();

  for (const dbPath of dbPaths) {
    const contacts = extractContactsFromDb(dbPath);
    for (const [key, contact] of contacts) {
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, contact);
        continue;
      }
      // Merge phones and emails
      for (const phone of contact.phones) {
        if (!existing.phones.includes(phone)) {
          existing.phones.push(phone);
        }
      }
      for (const email of contact.emails) {
        if (!existing.emails.includes(email)) {
          existing.emails.push(email);
        }
      }
      if (!existing.organization && contact.organization) {
        existing.organization = contact.organization;
      }
    }
  }

  // Sort by name and filter out contacts with no phone or email
  return [...merged.values()]
    .filter((c) => c.phones.length > 0 || c.emails.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function writeContactsJson(outputPath: string): { count: number; path: string } {
  const contacts = syncContacts();
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(outputPath, JSON.stringify(contacts, null, 2), "utf8");
  return { count: contacts.length, path: outputPath };
}

/**
 * Deterministic scheduler handler.
 * Reads IMESSAGE_CONTACTS_PATH env var to determine output location.
 */
export const contactsSyncHandler: DeterministicHandler = async (): Promise<DeterministicResult> => {
  const outputPath = process.env.IMESSAGE_CONTACTS_PATH?.trim();
  if (!outputPath) {
    return {
      status: "skipped",
      summary: "IMESSAGE_CONTACTS_PATH not set, skipping contacts sync",
    };
  }

  // Expand ~ to homedir
  const resolved = outputPath.startsWith("~/")
    ? path.join(os.homedir(), outputPath.slice(2))
    : outputPath;

  try {
    const result = writeContactsJson(resolved);
    return {
      status: "ok",
      summary: `Synced ${result.count} contacts to ${result.path}`,
      data: { count: result.count, path: result.path },
    };
  } catch (err) {
    return {
      status: "error",
      summary: `Contacts sync failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};
