import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isActiveHours, nextScheduledRefresh } from './schedule.js';
import { retainUnavailable } from './stale.js';
import { parseUsagePayload, type DashboardState, type RefreshSchedule, type UsagePayload } from './types.js';

export interface UsageMonitorOptions {
  collect: () => Promise<UsagePayload>;
  cachePath: string;
  schedule: RefreshSchedule;
  now?: () => Date;
}

type StateListener = (state: DashboardState) => void;

export class UsageMonitor {
  private readonly collect: () => Promise<UsagePayload>;
  private readonly cachePath: string;
  private readonly schedule: RefreshSchedule;
  private readonly now: () => Date;
  private readonly listeners = new Set<StateListener>();
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<DashboardState> | null = null;
  private state: DashboardState;

  constructor(options: UsageMonitorOptions) {
    this.collect = options.collect;
    this.cachePath = options.cachePath;
    this.schedule = options.schedule;
    this.now = options.now ?? (() => new Date());
    this.state = {
      usage: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      nextScheduledRefreshAt: null,
      refreshing: false,
      quietHours: !isActiveHours(this.now(), this.schedule),
      lastError: null,
      schedule: this.schedule,
    };
  }

  snapshot(): DashboardState {
    return structuredClone({
      ...this.state,
      quietHours: !isActiveHours(this.now(), this.schedule),
    });
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async initialize(): Promise<DashboardState> {
    await this.loadCache();
    if (isActiveHours(this.now(), this.schedule)) await this.refresh();
    this.scheduleNext();
    return this.snapshot();
  }

  async refresh(options: { force?: boolean } = {}): Promise<DashboardState> {
    if (!options.force && !isActiveHours(this.now(), this.schedule)) {
      this.patch({ quietHours: true });
      return this.snapshot();
    }
    if (this.inFlight) return this.inFlight;

    this.patch({
      refreshing: true,
      quietHours: !isActiveHours(this.now(), this.schedule),
      lastAttemptAt: this.now().toISOString(),
    });
    this.inFlight = (async () => {
      try {
        const parsed = retainUnavailable(parseUsagePayload(await this.collect()), this.state.usage);
        this.patch({
          usage: parsed,
          lastSuccessAt: parsed.generatedAt,
          lastError: null,
        });
        try {
          await this.persist(parsed);
        } catch (error) {
          this.patch({
            lastError: `Live data updated, but the local cache could not be saved: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      } catch (error) {
        this.patch({
          usage: this.state.usage ? { ...this.state.usage, accounts: this.state.usage.accounts.map((account) => ({
            ...account, live: false, staleReason: 'Live check failed — showing last known usage.',
          })) } : null,
          lastError: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.patch({ refreshing: false });
      }
      return this.snapshot();
    })();

    const result = await this.inFlight;
    this.inFlight = null;
    return result;
  }

  async refreshNow(): Promise<DashboardState> {
    await this.refresh({ force: true });
    this.scheduleNext();
    return this.snapshot();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async loadCache(): Promise<void> {
    try {
      const cached = parseUsagePayload(JSON.parse(await fs.readFile(this.cachePath, 'utf8')));
      this.patch({ usage: cached, lastSuccessAt: cached.generatedAt });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.patch({ lastError: `Cached usage is unavailable: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
  }

  private async persist(usage: UsagePayload): Promise<void> {
    const directory = path.dirname(this.cachePath);
    const tempPath = `${this.cachePath}.${process.pid}.tmp`;
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(tempPath, `${JSON.stringify(usage, null, 2)}\n`, { mode: 0o600 });
    await fs.chmod(tempPath, 0o600);
    await fs.rename(tempPath, this.cachePath);
  }

  private scheduleNext(): void {
    if (this.timer) clearTimeout(this.timer);
    const now = this.now();
    const next = nextScheduledRefresh(now, this.schedule);
    this.patch({
      quietHours: !isActiveHours(now, this.schedule),
      nextScheduledRefreshAt: next.toISOString(),
    });
    this.timer = setTimeout(async () => {
      await this.refresh();
      this.scheduleNext();
    }, Math.max(0, next.getTime() - now.getTime()));
    this.timer.unref();
  }

  private patch(patch: Partial<DashboardState>): void {
    this.state = { ...this.state, ...patch };
    const snapshot = this.snapshot();
    this.listeners.forEach((listener) => listener(snapshot));
  }
}
