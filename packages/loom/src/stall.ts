import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

/** Event-loop delay that counts as degraded: the loop's 99th percentile, or any single stall. */
export const LOOP_P99_MS = 250;
export const LOOP_MAX_MS = 2_000;
/** A subprocess that takes this long to start (or a probe this long to finish) counts as degraded. */
export const SPAWN_MS = 2_000;

export interface StallReading {
  at: number;
  loop: { p50Ms: number; p99Ms: number; maxMs: number };
  spawns: { count: number; maxMs: number; slowest: string | null };
  /** What keeps the process busy, by kind (process.getActiveResourcesInfo): a leak grows here over uptime. */
  resources: Record<string, number>;
  degraded: boolean;
}

/**
 * Loom's own stall signal, always on and cheap: the event loop's delay and how long subprocesses take to start, read
 * once a minute and logged (with the time, which loom.log lines otherwise lack) only when either is degraded.
 * On 10/23 the log filled with "pressure read took over 10000 ms" while the same commands took 5 ms from a shell,
 * and nothing said whether Loom's loop or its spawning was slow.
 */
export class StallMonitor {
  private histogram: IntervalHistogram | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private spawnCount = 0;
  private spawnMax = 0;
  private spawnSlowest: string | null = null;
  private last: StallReading | null = null;

  constructor(private readonly log: (line: string) => void = (line) => console.warn(line), private readonly now: () => number = Date.now) {}

  start(everyMs = 60_000): void {
    if (this.timer) return;
    this.histogram = monitorEventLoopDelay({ resolution: 20 });
    this.histogram.enable();
    this.timer = setInterval(() => this.sample(), everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.histogram?.disable();
    this.histogram = null;
  }

  /** How long one subprocess took to start (or a quick probe to finish), labelled by its command. */
  noteSpawn(label: string, ms: number): void {
    this.spawnCount++;
    if (ms > this.spawnMax) { this.spawnMax = ms; this.spawnSlowest = label; }
  }

  /** The latest minute's reading (null before the first). */
  reading(): StallReading | null { return this.last; }

  /** Reads and resets the minute's figures; logs one line when degraded. Public for tests. */
  sample(): StallReading {
    const h = this.histogram;
    const ms = (ns: number) => Math.round(ns / 1e6);
    const loop = h && h.count > 0 ? { p50Ms: ms(h.percentile(50)), p99Ms: ms(h.percentile(99)), maxMs: ms(h.max) } : { p50Ms: 0, p99Ms: 0, maxMs: 0 };
    const spawns = { count: this.spawnCount, maxMs: Math.round(this.spawnMax), slowest: this.spawnSlowest };
    const resources: Record<string, number> = {};
    for (const kind of process.getActiveResourcesInfo()) resources[kind] = (resources[kind] ?? 0) + 1;
    const degraded = loop.p99Ms >= LOOP_P99_MS || loop.maxMs >= LOOP_MAX_MS || spawns.maxMs >= SPAWN_MS;
    this.last = { at: this.now(), loop, spawns, resources, degraded };
    h?.reset();
    this.spawnCount = 0; this.spawnMax = 0; this.spawnSlowest = null;
    if (degraded) {
      const held = Object.entries(resources).sort((a, b) => b[1] - a[1]).map(([kind, n]) => `${kind}=${n}`).join(" ");
      this.log(`[loom] stall ${new Date(this.last.at).toISOString()}: event loop p50 ${loop.p50Ms} ms, p99 ${loop.p99Ms} ms, max ${loop.maxMs} ms; ` +
        `slowest of ${spawns.count} spawns ${spawns.maxMs} ms${spawns.slowest ? ` (${spawns.slowest})` : ""}; rss ${Math.round(process.memoryUsage.rss() / 2 ** 20)} MB; active ${held}`);
    }
    return this.last;
  }
}

/** The coordinator's monitor: main.ts starts it; spawn sites report to it whether or not it runs. */
export const stall = new StallMonitor();
