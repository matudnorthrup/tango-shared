import * as fs from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";

export class ReclaimTimeout extends Error {
  constructor(message = "inspect timed out") { super(message); }
}
interface Scope { abort: (reason: Error) => void; signal: AbortSignal; timeoutMs: number; io: ReclaimIO; settle?: boolean }
const scopes = new AsyncLocalStorage<Scope>();

/** Limits actual outstanding calls, including calls whose caller already timed out.
 * A timeout cannot cancel a kernel filesystem request: never give its slot away early.
 * There is no unbounded waiter queue; saturated inspections fail closed immediately.
 */
export class ReclaimIO {
  private pending = 0;
  constructor(readonly limit = 2) {}
  async call<T>(work: () => Promise<T>): Promise<T> {
    if (this.pending >= this.limit) throw new ReclaimTimeout();
    this.pending++;
    try { return await work(); } finally { this.pending--; }
  }
}

export function checkReclaim(): void { scopes.getStore()?.signal.throwIfAborted(); }

export async function reclaimCall<T>(work: () => Promise<T>): Promise<T> {
  const scope = scopes.getStore();
  if (!scope) return work();
  checkReclaim();
  try {
    if (scope.settle) { const result = await scope.io.call(work); checkReclaim(); return result; }
    return await deadline(() => scope.io.call(work), scope.timeoutMs, scope.signal);
  }
  catch (error) { if (error instanceof ReclaimTimeout) scope.abort(error); throw error; }
}

// Preserve overloads (notably readdir and statfs) on wrapped Node APIs.
export function reclaimBound<F extends (...args: any[]) => Promise<any>>(fn: F): F {
  return ((...args: Parameters<F>) => reclaimCall(() => fn(...args))) as F;
}

export async function deadline<T>(work: () => Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([Promise.resolve().then(() => { signal?.throwIfAborted(); return work(); }), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ReclaimTimeout()), ms);
      abort = () => reject(signal!.reason);
      signal?.addEventListener("abort", abort, { once: true });
    })]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

/** Abandoned work keeps its aborted context, so late completions cannot start new IO. */
export async function reclaimScope<T>(io: ReclaimIO, timeoutMs: number, passMs: number, work: () => Promise<T>): Promise<T> {
  const parent = scopes.getStore();
  const controller = new AbortController();
  const abort = () => controller.abort(parent!.signal.reason);
  parent?.signal.addEventListener("abort", abort, { once: true });
  if (parent?.signal.aborted) abort();
  try {
    return await scopes.run({ io, timeoutMs, abort: reason => controller.abort(reason), signal: controller.signal }, () => deadline(work, passMs, controller.signal));
  } finally {
    controller.abort(new ReclaimTimeout());
    parent?.signal.removeEventListener("abort", abort);
  }
}

/** Waits such as mailboxes need deadlines but must not consume filesystem slots. */
export async function reclaimWait<T>(work: () => Promise<T>, timeoutMs?: number): Promise<T> {
  const scope = scopes.getStore();
  if (!scope) return work();
  checkReclaim();
  return deadline(work, timeoutMs ?? scope.timeoutMs, scope.signal);
}

/** An issued mutation cannot be cancelled safely. Keep its caller (and mailbox)
 * alive until it settles, even if the pass watchdog has moved on to other rows.
 */
export async function reclaimMutation<T>(work: () => Promise<T>): Promise<T> {
  const scope = scopes.getStore();
  checkReclaim();
  const result = await (scope ? scope.io.call(work) : work());
  checkReclaim();
  return result;
}

/** Node's recursive rm fans out internally. During reclaim walk/unlink sequentially
 * instead, so each native call observes the same cap and abandonment guard.
 */
export const reclaimRemove: typeof fs.rm = async (path, options) => {
  if (!scopes.getStore() || !options?.recursive) return reclaimMutation(() => fs.rm(path, options));
  const name = path instanceof URL ? fileURLToPath(path) : path.toString();
  try {
    const info = await reclaimCall(() => fs.lstat(name));
    if (info.isDirectory() && !info.isSymbolicLink()) {
      for (const entry of await reclaimCall(() => fs.readdir(name))) await reclaimRemove(join(name, entry), options);
      await reclaimMutation(() => fs.rmdir(name));
    } else await reclaimMutation(() => fs.unlink(name));
  } catch (error) {
    if (options.force && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
};

/** A composite mutation consumes no slot itself. Once a native operation is issued,
 * keep the mailbox until it settles so recovery cannot race its late completion.
 */
export function reclaimTransaction<T>(work: () => Promise<T>): Promise<T> {
  const scope = scopes.getStore();
  return scope ? scopes.run({ ...scope, settle: true }, work) : work();
}

/** Only compensating operations may escape cancellation. They retain the same IO
 * budget and mailbox; never use this to continue ordinary work after abandonment.
 */
export function reclaimRecovery<T>(work: () => Promise<T>): Promise<T> {
  const scope = scopes.getStore();
  if (!scope) return work();
  const controller = new AbortController();
  return scopes.run({ ...scope, settle: true, signal: controller.signal, abort: reason => controller.abort(reason) }, work);
}
