import { describe, expect, it } from "vitest";
import { instructionBlock, LOOM_GUIDANCE, DEFAULT_ROLE_GUIDANCE, roleGuidance } from "../src/instructions.js";

describe("versioned instructions", () => {
  it("selects roles explicitly without leaking the coordinator's routing-only contract", () => {
    expect(LOOM_GUIDANCE).toContain("loom.wait_for");
    expect(roleGuidance("default")).toBe(DEFAULT_ROLE_GUIDANCE);
    expect(roleGuidance("worker")).toContain("Implement and verify your own work");
    expect(roleGuidance("ops")).toContain("A run that finds nothing ends quietly");
    for (const role of ["interactive", "unknown", "constructor", undefined, null]) expect(roleGuidance(role)).toBe("");
    for (const role of ["worker", "ops"]) expect(roleGuidance(role)).not.toContain("Never do the work yourself");
  });
  it("fails closed on malformed, empty or duplicated blocks", () => {
    const start = "<!-- loom:worker:start -->", end = "<!-- loom:worker:end -->";
    expect(instructionBlock(`${start}\nDo work.\n${end}`, "worker")).toBe("Do work.");
    for (const source of ["", `${start}${end}`, `${end}text${start}`, `${start}a${end}${start}b${end}`]) {
      expect(() => instructionBlock(source, "worker")).toThrow();
    }
  });
});
