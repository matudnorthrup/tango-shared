import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

function readGogKeyringPasswordFromEnvFile(cwd: string): string | undefined {
  try {
    const envText = fs.readFileSync(path.resolve(cwd, ".env"), "utf8");
    const password = dotenv.parse(envText).GOG_KEYRING_PASSWORD;
    return password || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build a GOG subprocess environment with the same dotenv semantics as the
 * long-running Discord process. A file value overrides a stale launcher value.
 */
export function createGogCommandEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): NodeJS.ProcessEnv {
  const password = readGogKeyringPasswordFromEnvFile(cwd);
  return password
    ? { ...baseEnv, GOG_KEYRING_PASSWORD: password }
    : { ...baseEnv };
}
