import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  buildOllamaChatBody,
  describeModelRoles,
  isModelInOllamaCatalog,
  parseModelRoles,
  resolveModelRole,
  resolveOllamaModelName,
  setModelRolesForTesting,
  tryResolveOllamaModelName,
} from "../src/index.js";

const roles = parseModelRoles(`
roles:
  quick:
    models: [deepseek-v4.1-flash, deepseek-v4-pro]
  empty:
    models: []
`);

afterEach(() => setModelRolesForTesting(undefined, null));

describe("model roles", () => {
  it("parses roles and drops empty ones", () => {
    expect([...roles.keys()]).toEqual(["quick"]);
  });

  it("serves the primary when the catalog is unknown (never blocks a turn)", () => {
    setModelRolesForTesting(roles, null);
    expect(resolveModelRole("role:quick")).toMatchObject({ model: "deepseek-v4.1-flash", rank: 0, catalogKnown: false });
  });

  it("falls through to the next tested model when the primary is retired", () => {
    setModelRolesForTesting(roles, ["deepseek-v4-pro:0813", "glm-5.3"]);
    expect(resolveModelRole("role:quick")).toMatchObject({ model: "deepseek-v4-pro", rank: 1, catalogKnown: true });
  });

  it("matches bare, :cloud and tagged ids against the catalog", () => {
    const catalog = ["deepseek-v4-pro:0813", "gemma4:31b"];
    expect(isModelInOllamaCatalog("deepseek-v4-pro", catalog)).toBe(true);
    expect(isModelInOllamaCatalog("deepseek-v4-pro:cloud", catalog)).toBe(true);
    expect(isModelInOllamaCatalog("gemma4:31b", catalog)).toBe(true);
    expect(isModelInOllamaCatalog("deepseek-v4-flash", catalog)).toBe(false);
  });

  it("passes plain model ids through and resolves built-in roles without a file", () => {
    setModelRolesForTesting(new Map(), null);
    expect(resolveOllamaModelName("glm-5.3")).toBe("glm-5.3");
    expect(resolveOllamaModelName("role:task-router")).toBe("gemma4:31b");
    expect(() => resolveOllamaModelName("role:nope")).toThrow(/Unknown model role/);
    expect(tryResolveOllamaModelName("role:nope")).toBe("role:nope");
  });

  it("resolves roles inside the Ollama request body", () => {
    setModelRolesForTesting(roles, ["deepseek-v4-pro"]);
    expect(buildOllamaChatBody({ prompt: "hi", model: "role:quick" }).model).toBe("deepseek-v4-pro");
  });

  it("reports role health for the scorecard", () => {
    setModelRolesForTesting(roles, null);
    expect(describeModelRoles(["deepseek-v4-pro"])).toEqual([
      { role: "quick", primary: "deepseek-v4.1-flash", serving: "deepseek-v4-pro", rank: 1 },
    ]);
    expect(describeModelRoles(["other"])[0]).toMatchObject({ serving: null });
  });

  it("the repo roles file parses and only lists roles with models", () => {
    const file = path.resolve(__dirname, "../../../config/model-roles.yaml");
    const parsed = parseModelRoles(fs.readFileSync(file, "utf8"));
    for (const name of ["memory-extraction", "kid-ledger", "task-router", "vision", "judgment", "job-planning", "job-digest"]) {
      expect(parsed.get(name)?.models.length ?? 0).toBeGreaterThan(0);
    }
  });
});
