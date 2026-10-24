import { expect, it } from "vitest";
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
