import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAttachmentRetentionPolicy,
  evaluateAttachmentRetention,
  loadAttachmentRetentionPolicy,
  retentionDecisionInputFromEvaluation,
  type AttachmentRetentionRule,
} from "../src/attachment-retention-policy.js";
import type { AttachmentRecord } from "../src/attachments-store.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTempConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-retention-policy-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, "attachment-retention-rules"), { recursive: true });
  return dir;
}

function createAttachment(overrides: Partial<AttachmentRecord> = {}): AttachmentRecord {
  return {
    id: 42,
    projectId: "tango",
    agentId: "watson",
    sessionId: "session-1",
    messageId: "message-1",
    channelId: "channel-1",
    threadId: "thread-1",
    userId: "user-1",
    discordAttachmentId: "discord-42",
    fileId: 7,
    title: "User image support screenshot",
    originalFilename: "image-support.png",
    contentType: "image/png",
    bytes: 2048,
    status: "ready",
    retentionPolicyId: null,
    metadata: {
      tags: ["private-user", "image-support"],
      sensitivity: "private",
      source_kind: "discord",
    },
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("attachment retention policy", () => {
  it("layers scoped retention rules into explainable artifact decisions without applying destructive actions", () => {
    const rules: AttachmentRetentionRule[] = [
      {
        id: "global-keep",
        schemaVersion: 1,
        enabled: true,
        priority: 0,
        scope: { type: "global" },
        actions: {
          all: {
            decision: "keep",
            reason: "Global default keeps artifacts.",
          },
        },
      },
      {
        id: "project-review-derived",
        schemaVersion: 2,
        enabled: true,
        priority: 10,
        scope: { type: "project", id: "tango" },
        match: {
          tags: ["private-user"],
          contentTypePrefixes: ["image/"],
        },
        actions: {
          extracted_text: {
            decision: "review",
            reason: "Project wants image OCR reviewed after use.",
            reviewAfterDays: 7,
          },
          chunks: {
            decision: "review",
            reason: "Project wants chunk retention reviewed.",
            reviewAfterDays: 7,
          },
          directories: {
            decision: "keep",
            reason: "Keep compact directories for project continuity.",
          },
        },
      },
      {
        id: "attachment-delete-sidecars",
        schemaVersion: 1,
        enabled: true,
        priority: 0,
        scope: { type: "attachment", id: "42" },
        actions: {
          sidecars: {
            decision: "delete",
            reason: "Explicit attachment override requests sidecar deletion.",
            afterDays: 30,
            reviewAfterDays: 0,
          },
        },
      },
    ];

    const policy = createAttachmentRetentionPolicy(rules);
    const evaluation = evaluateAttachmentRetention({
      attachment: createAttachment(),
      policy,
      now: new Date("2026-06-02T00:00:00.000Z"),
    });

    expect(evaluation.policyVersion).toBe(
      "attachment-retention:attachment-delete-sidecars@1,global-keep@1,project-review-derived@2",
    );
    expect(evaluation.overallDecision).toBe("delete");
    expect(evaluation.destructive).toBe(true);
    expect(evaluation.requiresReview).toBe(true);
    expect(evaluation.matchedRules.map((rule) => rule.ruleId)).toEqual([
      "global-keep",
      "project-review-derived",
      "attachment-delete-sidecars",
    ]);
    expect(evaluation.artifactDecisions.original).toMatchObject({
      decision: "keep",
      ruleId: "global-keep",
      destructive: false,
    });
    expect(evaluation.artifactDecisions.extracted_text).toMatchObject({
      decision: "review",
      ruleId: "project-review-derived",
      destructive: false,
    });
    expect(evaluation.artifactDecisions.directories).toMatchObject({
      decision: "keep",
      ruleId: "project-review-derived",
    });
    expect(evaluation.artifactDecisions.sidecars).toMatchObject({
      decision: "delete",
      ruleId: "attachment-delete-sidecars",
      destructive: true,
      effectiveAt: "2026-05-31T00:00:00.000Z",
      reviewAfter: "2026-06-02T00:00:00.000Z",
    });

    const input = retentionDecisionInputFromEvaluation(evaluation, {
      decidedBy: "agent:test",
    });

    expect(input).toMatchObject({
      retentionPolicyId: evaluation.policyVersion,
      decision: "delete",
      status: "proposed",
      decidedBy: "agent:test",
      effectiveAt: "2026-05-31T00:00:00.000Z",
      reviewAfter: "2026-06-02T00:00:00.000Z",
      metadata: {
        destructiveActionsApplied: false,
      },
    });
  });

  it("loads human-editable YAML rules and matches metadata, age, type, and scope", () => {
    const configDir = createTempConfigDir();
    fs.writeFileSync(
      path.join(configDir, "attachment-retention-rules", "global.yaml"),
      [
        "id: global-keep",
        "schema_version: 1",
        "enabled: true",
        "scope:",
        "  type: global",
        "actions:",
        "  all:",
        "    decision: keep",
        "    reason: Keep by default.",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(configDir, "attachment-retention-rules", "project-sensitive.yaml"),
      [
        "id: project-sensitive-image-review",
        "schema_version: 3",
        "description: Review private user images after one week.",
        "enabled: true",
        "priority: 20",
        "scope:",
        "  type: project",
        "  id: tango",
        "match:",
        "  content_type_prefixes:",
        "    - image/",
        "  filename_extensions:",
        "    - png",
        "  min_age_days: 7",
        "  tags:",
        "    - private-user",
        "  sensitivity:",
        "    - private",
        "  source_kinds:",
        "    - discord",
        "  metadata:",
        "    source_kind: discord",
        "actions:",
        "  extracted_text:",
        "    decision: review",
        "    reason: Review OCR text before long-term retention.",
        "    review_after_days: 0",
        "  chunks:",
        "    decision: review",
        "    reason: Review chunks before long-term retention.",
        "    review_after_days: 0",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(configDir, "attachment-retention-rules", "disabled.yaml"),
      [
        "id: disabled-delete",
        "schema_version: 1",
        "enabled: false",
        "scope:",
        "  type: global",
        "actions:",
        "  all:",
        "    decision: delete",
      ].join("\n"),
    );

    const policy = loadAttachmentRetentionPolicy(configDir);
    const evaluation = evaluateAttachmentRetention({
      attachment: createAttachment(),
      policy,
      now: new Date("2026-05-10T00:00:00.000Z"),
    });

    expect(policy.rules.map((rule) => rule.id)).toEqual([
      "global-keep",
      "project-sensitive-image-review",
    ]);
    expect(evaluation.matchedRules.map((rule) => rule.ruleId)).toEqual([
      "global-keep",
      "project-sensitive-image-review",
    ]);
    expect(evaluation.artifactDecisions.extracted_text).toMatchObject({
      decision: "review",
      ruleId: "project-sensitive-image-review",
      reviewAfter: "2026-05-10T00:00:00.000Z",
    });
    expect(evaluation.artifactDecisions.chunks).toMatchObject({
      decision: "review",
      ruleId: "project-sensitive-image-review",
    });
    expect(evaluation.artifactDecisions.original).toMatchObject({
      decision: "keep",
      ruleId: "global-keep",
    });
    expect(evaluation.summary).toContain("matched rules=global-keep, project-sensitive-image-review");
  });

  it("ignores scoped rules that do not match the attachment", () => {
    const policy = createAttachmentRetentionPolicy([
      {
        id: "global-keep",
        schemaVersion: 1,
        enabled: true,
        priority: 0,
        scope: { type: "global" },
        actions: { all: { decision: "keep" } },
      },
      {
        id: "other-project-delete",
        schemaVersion: 1,
        enabled: true,
        priority: 99,
        scope: { type: "project", id: "other" },
        actions: { all: { decision: "delete" } },
      },
    ]);

    const evaluation = evaluateAttachmentRetention({
      attachment: createAttachment({ projectId: "tango" }),
      policy,
      now: new Date("2026-06-02T00:00:00.000Z"),
    });

    expect(evaluation.overallDecision).toBe("keep");
    expect(evaluation.destructive).toBe(false);
    expect(evaluation.matchedRules.map((rule) => rule.ruleId)).toEqual(["global-keep"]);
  });
});
