// The person this desk belongs to, as hand-offs name them. Who they are lives in the profile's config/owner.yaml
// (the repo is public): `id` when it has one, else `display_name`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { profileDir } from "./decisions.js";

export interface DeskPerson { id: string; name: string }

export function deskPerson(env: NodeJS.ProcessEnv = process.env): DeskPerson | null {
  let raw: unknown;
  try { raw = yaml.load(readFileSync(join(profileDir(env), "config", "owner.yaml"), "utf8")); } catch { raw = null; }
  const file = (raw && typeof raw === "object" ? raw : {}) as { id?: unknown; display_name?: unknown };
  const name = typeof file.display_name === "string" && file.display_name.trim() ? file.display_name.trim() : env.TANGO_OWNER_NAME?.trim();
  const id = typeof file.id === "string" && file.id.trim() ? file.id.trim() : name?.toLowerCase();
  return id && name ? { id, name } : id ? { id, name: id } : null;
}

/** Whether a hand-off's `who` is the desk's person: their id or name, any case. */
export function isDeskPerson(who: string, person: DeskPerson | null = deskPerson()): boolean {
  const said = who.trim().toLowerCase();
  return !!person && !!said && (said === person.id.toLowerCase() || said === person.name.toLowerCase());
}
