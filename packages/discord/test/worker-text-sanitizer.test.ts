import { describe, expect, it } from "vitest";
import {
  coerceWorkerReplyForDisplay,
  sanitizeWorkerTextForDisplay,
} from "../src/worker-text-sanitizer.js";

describe("sanitizeWorkerTextForDisplay", () => {
  it("passes through plain prose unchanged", () => {
    expect(sanitizeWorkerTextForDisplay("Here is your answer.")).toBe("Here is your answer.");
  });

  it("blanks a pure JSON object reply", () => {
    expect(sanitizeWorkerTextForDisplay('{"response":"hi","done":true}')).toBe("");
  });

  it("strips an accidental ```json fence but keeps surrounding prose", () => {
    const input = "Sure, here it is:\n```json\n{\"a\":1}\n```\nLet me know if that helps.";
    const out = sanitizeWorkerTextForDisplay(input);
    expect(out).toContain("Sure, here it is:");
    expect(out).toContain("Let me know if that helps.");
    expect(out).not.toContain("```");
    expect(out).not.toContain('"a"');
  });

  it("returns empty for non-string input", () => {
    expect(sanitizeWorkerTextForDisplay(undefined)).toBe("");
    expect(sanitizeWorkerTextForDisplay({ a: 1 })).toBe("");
  });
});

describe("coerceWorkerReplyForDisplay", () => {
  it("passes through plain prose unchanged", () => {
    expect(coerceWorkerReplyForDisplay("All set — booked for Monday.")).toBe("All set — booked for Monday.");
  });

  it("keeps prose and drops an accidental json fence", () => {
    const out = coerceWorkerReplyForDisplay("Done.\n```json\n{\"ok\":true}\n```");
    expect(out).toBe("Done.");
  });

  it("salvages a human-readable field from a pure-JSON reply (never blanks)", () => {
    expect(coerceWorkerReplyForDisplay('{"response":"The capital is Paris.","confidence":0.9}'))
      .toBe("The capital is Paris.");
    expect(coerceWorkerReplyForDisplay('{"message":"Got it, logged your workout."}'))
      .toBe("Got it, logged your workout.");
  });

  it("falls back to the original text when no readable field exists (no empty reply)", () => {
    const input = '{"status":200,"items":[1,2,3]}';
    expect(coerceWorkerReplyForDisplay(input)).toBe(input);
  });

  it("returns empty only for non-string input", () => {
    expect(coerceWorkerReplyForDisplay(null)).toBe("");
  });
});
