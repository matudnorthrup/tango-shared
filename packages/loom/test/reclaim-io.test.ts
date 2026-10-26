import { expect, it, vi } from "vitest";
vi.mock("node:fs/promises", async importOriginal => ({ ...await importOriginal<typeof import("node:fs/promises")>() }));

import { ReclaimIO, ReclaimTimeout, reclaimCall, reclaimScope } from "../src/reclaim-io.js";

it("retains slots for timed-out native requests and never queues more work", async () => {
  const io = new ReclaimIO(2);
  let started = 0;
  const releases: (() => void)[] = [];
  const hanging = () => reclaimScope(io, 10, 100, () => reclaimCall(() => {
    started++;
    return new Promise<void>(resolve => releases.push(resolve));
  }));
  await expect(hanging()).rejects.toBeInstanceOf(ReclaimTimeout);
  await expect(hanging()).rejects.toBeInstanceOf(ReclaimTimeout);
  for (let i = 0; i < 20; i++) await expect(hanging()).rejects.toBeInstanceOf(ReclaimTimeout);
  expect(started).toBe(2);
  for (const release of releases) release();
  await new Promise(resolve => setImmediate(resolve));
  expect(await reclaimScope(io, 100, 100, () => reclaimCall(async () => "recovered"))).toBe("recovered");
});

it("blocks late continuations after the pass watchdog expires", async () => {
  const io = new ReclaimIO();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let mutated = false;
  let late!: Promise<unknown>;
  await expect(reclaimScope(io, 1000, 10, () => {
    late = (async () => { await gate; await reclaimCall(async () => { mutated = true; }); })();
    return late;
  })).rejects.toBeInstanceOf(ReclaimTimeout);
  release();
  await expect(late).rejects.toBeInstanceOf(ReclaimTimeout);
  expect(mutated).toBe(false);
});

it("holds an issued mutation until it settles after pass abandonment", async () => {
  const { reclaimMutation } = await import("../src/reclaim-io.js");
  const io = new ReclaimIO(1);
  let release!: () => void;
  let finished = false;
  let mutation!: Promise<void>;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await expect(reclaimScope(io, 100, 10, () => {
    mutation = reclaimMutation(() => gate).finally(() => { finished = true; });
    return mutation;
  })).rejects.toBeInstanceOf(ReclaimTimeout);
  expect(finished).toBe(false);
  await expect(reclaimScope(io, 100, 100, () => reclaimCall(async () => "new call"))).rejects.toBeInstanceOf(ReclaimTimeout);
  release();
  await expect(mutation).rejects.toBeInstanceOf(ReclaimTimeout);
  expect(finished).toBe(true);
});

it("removes a tree sequentially without following directory symlinks", async () => {
  const fs = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { reclaimRemove } = await import("../src/reclaim-io.js");
  const root = await fs.mkdtemp(join(tmpdir(), "reclaim-io-"));
  try {
    await fs.mkdir(join(root, "tree"));
    await fs.mkdir(join(root, "outside"));
    await fs.writeFile(join(root, "outside", "keep"), "safe");
    await fs.writeFile(join(root, "tree", "remove"), "cache");
    await fs.symlink(join(root, "outside"), join(root, "tree", "link"));
    await reclaimScope(new ReclaimIO(1), 1000, 5000, () => reclaimRemove(join(root, "tree"), { recursive: true, force: true }));
    expect(await fs.readFile(join(root, "outside", "keep"), "utf8")).toBe("safe");
    await expect(fs.stat(join(root, "tree"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it("renews an idle pass on nested native progress without extending inspection deadlines", async () => {
  const { vi } = await import("vitest");
  vi.useFakeTimers();
  const io = new ReclaimIO();
  const step = () => reclaimCall(() => new Promise<void>(resolve => setTimeout(resolve, 40)));
  try {
    const pass = reclaimScope(io, 50, 100, async () => {
      for (let i = 0; i < 8; i++) await reclaimScope(io, 50, 100, step);
      return "complete";
    }, true);
    const result = expect(pass).resolves.toBe("complete");
    await vi.advanceTimersByTimeAsync(320);
    await result;

    const fixed = reclaimScope(io, 50, 100, () => reclaimScope(io, 50, 100, async () => {
      for (let i = 0; i < 8; i++) await step();
    }), true);
    const timeout = expect(fixed).rejects.toBeInstanceOf(ReclaimTimeout);
    await vi.advanceTimersByTimeAsync(100);
    await timeout;
  } finally { vi.useRealTimers(); }
});

it("abandons a truly idle pass, fences late IO, and allows recovery", async () => {
  const { vi } = await import("vitest");
  vi.useFakeTimers();
  const io = new ReclaimIO();
  let release!: () => void;
  let late!: Promise<void>;
  let mutated = false;
  try {
    const pass = reclaimScope(io, 1000, 100, () => {
      late = (async () => {
        await new Promise<void>(resolve => { release = resolve; });
        await reclaimCall(async () => { mutated = true; });
      })();
      return late;
    }, true);
    const timeout = expect(pass).rejects.toBeInstanceOf(ReclaimTimeout);
    await vi.advanceTimersByTimeAsync(100);
    await timeout;
    release();
    await expect(late).rejects.toBeInstanceOf(ReclaimTimeout);
    expect(mutated).toBe(false);
    await expect(reclaimScope(io, 50, 100, () => reclaimCall(async () => "recovered"), true)).resolves.toBe("recovered");
  } finally { vi.useRealTimers(); }
});


it("keeps the two-call cap when concurrent removals occupy both slots and a disk probe retries", async () => {
  const fs = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { reclaimRemove, reclaimTransaction } = await import("../src/reclaim-io.js");
  const root = await fs.mkdtemp(join(tmpdir(), "reclaim-two-"));
  const io = new ReclaimIO(2);
  const gates: (() => void)[] = [];
  const original = fs.unlink;
  let pending = 0, maximum = 0;
  const spy = vi.spyOn(fs, "unlink").mockImplementation(async path => {
    pending++; maximum = Math.max(maximum, pending);
    try { await new Promise<void>(resolve => gates.push(resolve)); await original(path); }
    finally { pending--; }
  });
  try {
    for (const tree of ["a", "b"]) {
      await fs.mkdir(join(root, tree));
      for (let i = 0; i < 4; i++) await fs.writeFile(join(root, tree, String(i)), "cache");
    }
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const removals = ["a", "b"].map(tree => reclaimScope(io, 50, 100, () => reclaimTransaction(() => reclaimRemove(join(root, tree), { recursive: true })), true));
    for (let batch = 0; batch < 4; batch++) {
      while (gates.length < 2) await new Promise(resolve => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(60);
      // No unbounded waiter queue and no unaccounted third native operation.
      const probe = vi.fn(() => fs.statfs(root));
      await expect(reclaimScope(io, 50, 100, () => reclaimCall(probe))).rejects.toBeInstanceOf(ReclaimTimeout);
      expect(probe).not.toHaveBeenCalled();
      for (const release of gates.splice(0)) release();
    }
    await Promise.all(removals);
    expect(maximum).toBe(2);
    expect((await reclaimScope(io, 50, 100, () => reclaimCall(() => fs.statfs(root)))).bsize).toBeGreaterThan(0);
  } finally { for (const release of gates.splice(0)) release(); vi.useRealTimers(); spy.mockRestore(); await fs.rm(root, { recursive: true, force: true }); }
});
