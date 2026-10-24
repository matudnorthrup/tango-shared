// Machine-wide run slots shared by load-cap.mjs (local runs) and test-pool.mjs (runs sent to pool machines).
import fs from "node:fs";
import path from "node:path";

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

/** A slot without a pid yet may belong to a wrapper still starting up; only an old one is abandoned. */
function freshDir(dir) {
  try { return Date.now() - fs.statSync(dir).mtimeMs < 10_000; } catch { return false; }
}

/** A slot is a directory holding its owner's pid; one whose owner is gone is taken over. Returns the slot dir, or null. */
export function tryAcquire(root, runs, pid = process.pid) {
  fs.mkdirSync(root, { recursive: true });
  for (let i = 0; i < runs; i++) {
    const dir = path.join(root, `slot-${i}`);
    try {
      fs.mkdirSync(dir);
    } catch {
      let owner = NaN;
      try { owner = Number(fs.readFileSync(path.join(dir, "pid"), "utf8")); } catch { /* being created or gone */ }
      if (Number.isFinite(owner) ? alive(owner) : freshDir(dir)) continue;
      try { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir); } catch { continue; }
    }
    fs.writeFileSync(path.join(dir, "pid"), String(pid));
    return dir;
  }
  return null;
}

export function release(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
}
