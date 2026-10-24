import fs from "node:fs";
import os from "node:os";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

export const LOG_WARN_BYTES = 50 * 1024 * 1024;
export const LOG_ROTATE_BYTES = 100 * 1024 * 1024;
export const LOG_KEEP = 3;

export function expandLogPath(p: string): string {
  return p.replace(/^~(?=\/|$)/, os.homedir());
}

/**
 * Rotates a log in place so the writer's open descriptor keeps working:
 * shift `<log>.N.gz` up (dropping the oldest past `keep`), gzip a copy to
 * `<log>.1.gz`, then truncate the original.
 */
export async function rotateLog(file: string, keep = LOG_KEEP): Promise<void> {
  const gz = (n: number) => `${file}.${n}.gz`;
  if (fs.existsSync(gz(keep))) fs.rmSync(gz(keep), { force: true });
  for (let n = keep - 1; n >= 1; n--) {
    if (fs.existsSync(gz(n))) fs.renameSync(gz(n), gz(n + 1));
  }
  const tmp = `${gz(1)}.tmp`;
  await pipeline(fs.createReadStream(file), createGzip(), fs.createWriteStream(tmp));
  fs.renameSync(tmp, gz(1));
  fs.truncateSync(file, 0);
}
