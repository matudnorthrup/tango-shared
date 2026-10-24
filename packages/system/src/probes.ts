import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import type { ServiceAnnotation } from "./annotations.js";
import type { SystemContext } from "./context.js";
import type { HealthSnapshot } from "./types.js";

export interface ProbeResult {
  ok: boolean;
  detail: string;
  /** The probe could not run at all (CLI missing): report, but raise no event. */
  unavailable?: boolean;
}

function tcpProbe(host: string, port: number, timeoutMs: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (r: ProbeResult) => {
      sock.destroy();
      resolve(r);
    };
    sock.setTimeout(timeoutMs, () => done({ ok: false, detail: `no answer on ${host}:${port}` }));
    sock.once("connect", () => done({ ok: true, detail: `listening on ${port}` }));
    sock.once("error", (err) => done({ ok: false, detail: (err as NodeJS.ErrnoException).code ?? err.message }));
  });
}

export async function probeService(ctx: SystemContext, s: ServiceAnnotation): Promise<ProbeResult> {
  if (s.url) {
    const t0 = Date.now();
    const r = await ctx.fetch(s.url, { timeoutMs: 8000 });
    if ("error" in r) return { ok: false, detail: r.error };
    const ms = Date.now() - t0;
    return r.status < 500 ? { ok: true, detail: `HTTP ${r.status} in ${ms} ms` } : { ok: false, detail: `HTTP ${r.status}` };
  }
  if (s.port) return tcpProbe(s.host ?? "127.0.0.1", s.port, 2000);
  if (s.cmd === "tailscale") {
    const r = await ctx.exec("tailscale", ["status", "--json"], { timeoutMs: 8000 });
    if (r.error && r.code === null && !r.timedOut) return { ok: false, detail: "tailscale not installed", unavailable: true };
    if (r.code !== 0) return { ok: false, detail: r.timedOut ? "tailscale status timed out" : r.stderr.trim() || `exit ${r.code}` };
    try {
      const j = JSON.parse(r.stdout) as { BackendState?: string; Self?: { Online?: boolean } };
      const ok = j.BackendState === "Running";
      return { ok, detail: j.BackendState ?? "unknown" };
    } catch {
      return { ok: false, detail: "unreadable tailscale status" };
    }
  }
  if (s.cmd === "docker") {
    const r = await ctx.exec("docker", ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 10000 });
    if (r.error && r.code === null && !r.timedOut) return { ok: false, detail: "docker not installed", unavailable: true };
    if (r.code !== 0) return { ok: false, detail: r.timedOut ? "docker info timed out" : r.stderr.trim().split("\n")[0] || `exit ${r.code}` };
    return { ok: true, detail: `engine ${r.stdout.trim()}` };
  }
  if (s.cmd) {
    const [bin, ...args] = s.cmd.split(/\s+/);
    const r = await ctx.exec(bin!, args, { timeoutMs: 4000 });
    return r.code === 0 ? { ok: true, detail: "ok" } : { ok: false, detail: r.error ?? `exit ${r.code}` };
  }
  return { ok: false, detail: "no probe configured", unavailable: true };
}

/** macOS `vm_stat`: used = active + wired + compressor-occupied pages. */
export function parseVmStat(text: string): number | null {
  const page = Number(text.match(/page size of (\d+) bytes/)?.[1] ?? NaN);
  const pages = (label: string) => Number(text.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1] ?? 0);
  if (!Number.isFinite(page)) return null;
  return (pages("Pages active") + pages("Pages wired down") + pages("Pages occupied by compressor")) * page;
}

export async function machineHealth(ctx: SystemContext): Promise<HealthSnapshot["machine"]> {
  const [load1 = 0, load5 = 0] = os.loadavg();
  const total = os.totalmem();
  let used = total - os.freemem();
  if (process.platform === "darwin") {
    const r = await ctx.exec("vm_stat", [], { timeoutMs: 2000 });
    const v = r.code === 0 ? parseVmStat(r.stdout) : null;
    if (v !== null) used = v;
  }
  let diskUsedPct = 0;
  let diskFreeGb = 0;
  try {
    const st = fs.statfsSync(fs.existsSync(ctx.dataDir) ? ctx.dataDir : ctx.homeDir);
    const totalB = st.blocks * st.bsize;
    const freeB = st.bavail * st.bsize;
    diskUsedPct = totalB > 0 ? Math.round(((totalB - freeB) / totalB) * 1000) / 10 : 0;
    diskFreeGb = Math.round((freeB / 1024 ** 3) * 10) / 10;
  } catch {
    // statfs unavailable
  }
  const gb = (b: number) => Math.round((b / 1024 ** 3) * 10) / 10;
  return {
    load1: Math.round(load1 * 100) / 100,
    load5: Math.round(load5 * 100) / 100,
    cores: os.cpus().length,
    memUsedGb: gb(used),
    memTotalGb: gb(total),
    diskUsedPct,
    diskFreeGb,
  };
}
