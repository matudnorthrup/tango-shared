import { describe, expect, it } from "vitest";
import { isReadOnlyGogDocsCommand } from "../src/gog-docs-access.js";
import { createDocsTools } from "../src/personal-agent-tools.js";

describe("isReadOnlyGogDocsCommand", () => {
  it("permits targeted multi-tab reads", () => {
    expect(isReadOnlyGogDocsCommand("docs list-tabs doc-123")).toBe(true);
    expect(isReadOnlyGogDocsCommand("docs cat doc-123 --tab Draft-1")).toBe(true);
    expect(isReadOnlyGogDocsCommand("docs structure doc-123 --tab Draft-1")).toBe(true);
  });

  it("keeps document mutations as writes", () => {
    expect(isReadOnlyGogDocsCommand("docs write doc-123 --text revised")).toBe(false);
    expect(isReadOnlyGogDocsCommand("docs delete doc-123 --start 1 --end 2")).toBe(false);
  });
});

describe("gog_docs guidance", () => {
  it("directs agents to discover and explicitly select a requested tab", () => {
    const tool = createDocsTools().find((candidate) => candidate.name === "gog_docs");

    expect(tool?.description).toContain("gog docs list-tabs <docId>");
    expect(tool?.description).toContain("gog docs cat <docId> --tab '<tab title or id>'");
    expect(tool?.description).toContain("Do not claim a tab is unavailable before trying that targeted read.");
  });
});
