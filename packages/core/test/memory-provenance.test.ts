import { describe, expect, it } from "vitest";
import {
  formatRetrievedMemoryLine,
  resolveMemoryProvenance,
  RETRIEVED_MEMORY_GUIDANCE,
} from "../src/memory-provenance.js";

describe("memory provenance prompt formatting", () => {
  it("marks a dated conversation memory as prior context with its human label", () => {
    const line = formatRetrievedMemoryLine({
      content: "Reviewers should remember what the reader can actually observe.",
      source: "conversation",
      createdAt: "2026-07-12T18:30:00.000Z",
      metadata: {
        origin: {
          version: 1,
          kind: "conversation",
          occurred_at: "2026-07-12T17:00:00.000Z",
          context_label: "shared-knowledge review",
          context_ref: "thread:100000000000000003",
        },
      },
    });

    expect(line).toBe(
      "- [Prior memory · 2026-07-12 · shared-knowledge review · conversation] Reviewers should remember what the reader can actually observe.",
    );
    expect(RETRIEVED_MEMORY_GUIDANCE).toContain("not evidence from the current source");
    expect(line).not.toContain("100000000000000003");
  });

  it("uses document title and heading without exposing an absolute source path", () => {
    const line = formatRetrievedMemoryLine({
      content: "A durable architecture note.",
      source: "obsidian",
      createdAt: "2026-07-10T10:00:00.000Z",
      sourceRef: "obsidian:/private/test/vault/Architecture.md#4",
      metadata: {
        title: "Architecture",
        heading: "Retrieval boundaries",
        filePath: "/private/test/vault/Architecture.md",
      },
    });

    expect(line).toContain("Prior source memory · 2026-07-10 · Architecture / Retrieval boundaries · source document");
    expect(line).not.toContain("/private/test/");
    expect(line).not.toContain("sourceRef");
  });

  it("rejects path-, ID-, and malformed-date labels and degrades safely", () => {
    const provenance = resolveMemoryProvenance({
      source: "manual",
      createdAt: "not-a-date",
      metadata: {
        origin: {
          version: 1,
          kind: "manual",
          context_label: "/private/test/topic.md",
        },
        context_label: "100000000000000003",
      },
    });

    expect(provenance).toEqual({
      classification: "Prior memory",
      date: null,
      context: "manual save",
      source: "manual",
    });
  });

  it("distinguishes generated reflections from observed conversation memories", () => {
    expect(formatRetrievedMemoryLine({
      content: "A reflection compiled from earlier exchanges.",
      source: "reflection",
      createdAt: "2026-07-19T20:00:00.000Z",
      metadata: null,
    })).toContain("[Prior reflection · 2026-07-19 · prior reflection · reflection]");
  });
});
