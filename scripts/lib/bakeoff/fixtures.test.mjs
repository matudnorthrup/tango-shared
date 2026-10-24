import { test } from "node:test";
import assert from "node:assert/strict";

import { isClaudeModel } from "./fixtures.mjs";

test("isClaudeModel matches the claude: CLI-alias prefix", () => {
  assert.equal(isClaudeModel("claude:sonnet"), true);
  assert.equal(isClaudeModel("claude:opus"), true);
});

test("isClaudeModel matches bare runtime ids as used in agent configs", () => {
  assert.equal(isClaudeModel("claude-opus-4-8"), true);
  assert.equal(isClaudeModel("claude-sonnet-5"), true);
  assert.equal(isClaudeModel("claude-haiku-4-5"), true);
});

test("isClaudeModel rejects non-Claude models and non-strings", () => {
  assert.equal(isClaudeModel("deepseek-v4-pro:cloud"), false);
  assert.equal(isClaudeModel("glm-5.2"), false);
  assert.equal(isClaudeModel("claudius-1"), false);
  assert.equal(isClaudeModel(null), false);
  assert.equal(isClaudeModel(undefined), false);
});
