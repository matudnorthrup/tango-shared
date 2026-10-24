import { describe, expect, it } from "vitest";
import { fingerprint, normalize } from "../src/fingerprint.js";

describe("normalize", () => {
  it("lowercases and replaces numbers", () => {
    expect(normalize("Backup FAILED after 3 tries")).toBe("backup failed after <n> tries");
  });

  it("replaces ISO timestamps, UUIDs and hex ids", () => {
    expect(normalize("run 2026-10-18T15:08:48.676Z failed")).toBe("run <ts> failed");
    expect(normalize("thread 6d55ff4b-905a-4c6a-8360-9fbacb484803 stuck")).toBe("thread <uuid> stuck");
    expect(normalize("commit ae5f3034bbd1 broke it")).toBe("commit <hex> broke it");
    expect(normalize("addr 0x7ffee4")).toBe("addr <hex>");
  });

  it("replaces durations, ports and absolute paths", () => {
    expect(normalize("timed out after 4012ms")).toBe("timed out after <dur>");
    expect(normalize("took 3.2s")).toBe("took <dur>");
    expect(normalize("no answer on 127.0.0.1:9200")).toBe("no answer on <n>.<n>:<port>");
    expect(normalize("cannot read /home/someone/logs/app.log")).toBe("cannot read <path>");
    expect(normalize("missing (~/bin/tool)")).toBe("missing (<path>)");
  });

  it("replaces long quoted strings but keeps short ones", () => {
    const long = `"${"x".repeat(45)}"`;
    expect(normalize(`error ${long}`)).toBe("error <str>");
    expect(normalize('error "short one"')).toBe('error "short one"');
  });

  it("folds titles that differ only in variable parts", () => {
    const a = normalize("Backup failed at 2026-10-18T03:30:00Z after 4012ms (exit 1) /tmp/a.log");
    const b = normalize("backup failed at 2026-10-19T03:31:07Z after 515ms (exit 2) /var/tmp/b.log");
    expect(a).toBe(b);
  });
});

describe("fingerprint", () => {
  it("is stable for the same job, kind and normalized title", () => {
    expect(fingerprint("launchd:x", "run.failed", "X failed (exit 1)")).toBe(fingerprint("launchd:x", "run.failed", "x failed (exit 7)"));
  });

  it("differs by job and by kind, not by source", () => {
    const base = fingerprint("launchd:x", "run.failed", "X failed");
    expect(fingerprint("launchd:y", "run.failed", "X failed")).not.toBe(base);
    expect(fingerprint("launchd:x", "job.late", "X failed")).not.toBe(base);
  });
});
