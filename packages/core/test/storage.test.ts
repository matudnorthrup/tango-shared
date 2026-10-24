import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { GovernanceChecker } from "../src/governance.js";
import { TangoStorage } from "../src/storage.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createStorage(): { storage: TangoStorage; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-storage-"));
  tempDirs.push(dir);
  const storage = new TangoStorage(path.join(dir, "tango.sqlite"), { seedExampleRoster: true });
  return { storage, dir };
}

describe("TangoStorage", () => {
  it("upserts and retrieves provider sessions per provider", () => {
    const { storage } = createStorage();
    storage.bootstrapSessions([
      {
        id: "tango-default",
        type: "persistent",
        agent: "dispatch",
        channels: ["discord:default"]
      }
    ]);

    storage.upsertProviderSession({
      conversationKey: "tango-default:watson",
      sessionId: "tango-default",
      agentId: "watson",
      providerName: "claude-oauth",
      providerSessionId: "session-1"
    });

    storage.upsertProviderSession({
      conversationKey: "tango-default:watson",
      sessionId: "tango-default",
      agentId: "watson",
      providerName: "claude-oauth",
      providerSessionId: "session-2"
    });
    storage.upsertProviderSession({
      conversationKey: "tango-default:watson",
      sessionId: "tango-default",
      agentId: "watson",
      providerName: "codex",
      providerSessionId: "thread-1"
    });

    const claude = storage.getProviderSession("tango-default:watson", "claude-oauth");
    expect(claude?.providerSessionId).toBe("session-2");
    expect(claude?.agentId).toBe("watson");
    expect(claude?.providerName).toBe("claude-oauth");

    const codex = storage.getProviderSession("tango-default:watson", "codex");
    expect(codex?.providerSessionId).toBe("thread-1");
    expect(codex?.providerName).toBe("codex");

    expect(storage.clearProviderSession("tango-default:watson", "claude-oauth")).toBe(true);
    expect(storage.getProviderSession("tango-default:watson", "claude-oauth")).toBeNull();
    expect(storage.getProviderSession("tango-default:watson", "codex")?.providerSessionId).toBe("thread-1");

    storage.close();
  });

  it("persists inbound and outbound messages", () => {
    const { storage } = createStorage();
    storage.bootstrapSessions([
      {
        id: "tango-default",
        type: "persistent",
        agent: "dispatch",
        channels: ["discord:default"]
      }
    ]);

    storage.insertMessage({
      sessionId: "tango-default",
      agentId: "watson",
      providerName: "claude-oauth",
      direction: "inbound",
      source: "discord",
      discordMessageId: "1",
      discordChannelId: "chan-1",
      discordUserId: "user-1",
      discordUsername: "alice",
      content: "hello",
      metadata: { route: "tango-default" }
    });

    storage.insertMessage({
      sessionId: "tango-default",
      agentId: "watson",
      providerName: "claude-oauth",
      direction: "outbound",
      source: "tango",
      discordChannelId: "chan-1",
      content: "Hi there",
      metadata: { latencyMs: 1200 }
    });

    const messages = storage.listMessagesForSession("tango-default", 10);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.direction).toBe("inbound");
    expect(messages[0]?.visibility).toBe("public");
    expect(messages[0]?.content).toBe("hello");
    expect(messages[1]?.direction).toBe("outbound");
    expect(messages[1]?.content).toBe("Hi there");
    expect(messages[1]?.metadata).toMatchObject({ latencyMs: 1200 });

    storage.close();
  });

  it("looks up Discord messages by message ID and persists one-shot channel referents", () => {
    const { storage } = createStorage();
    storage.bootstrapSessions([
      {
        id: "tango-default",
        type: "persistent",
        agent: "dispatch",
        channels: ["discord:default"]
      }
    ]);

    storage.insertMessage({
      sessionId: "tango-default",
      agentId: "watson",
      direction: "outbound",
      source: "tango",
      discordMessageId: "discord-msg-1",
      discordChannelId: "chan-1",
      content: "Thursday's a clean slate.",
      metadata: { scheduledDelivery: true }
    });

    storage.insertMessage({
      sessionId: "tango-default",
      agentId: "watson",
      direction: "outbound",
      source: "tango",
      discordChannelId: "chan-1",
      content: "Secondary chunk for the same channel.",
      metadata: { scheduledDelivery: true }
    });

    expect(
      storage.getMessageByDiscordMessageId("discord-msg-1", { channelId: "chan-1" })?.content
    ).toBe("Thursday's a clean slate.");
    expect(storage.listRecentMessagesForDiscordChannel("chan-1", 10)).toHaveLength(2);

    storage.upsertChannelReferent({
      channelId: "chan-1",
      discordUserId: "user-1",
      kind: "reaction",
      targetMessageId: "discord-msg-1",
      targetSessionId: "tango-default",
      targetAgentId: "watson",
      targetDirection: "outbound",
      targetSource: "tango",
      targetContent: "Thursday's a clean slate.",
      metadata: { emoji: "✅" }
    });

    expect(storage.getChannelReferent("chan-1", "user-1")).toMatchObject({
      channelId: "chan-1",
      discordUserId: "user-1",
      targetSessionId: "tango-default",
      targetAgentId: "watson",
      targetContent: "Thursday's a clean slate.",
      metadata: { emoji: "✅" }
    });
    expect(storage.clearChannelReferent("chan-1", "user-1")).toBe(true);
    expect(storage.getChannelReferent("chan-1", "user-1")).toBeNull();

    storage.upsertChannelReferent({
      channelId: "chan-1",
      discordUserId: "user-1",
      kind: "reaction",
      targetMessageId: "discord-msg-1",
      targetContent: "expired",
      expiresAt: "2000-01-01 00:00:00"
    });
    expect(storage.getChannelReferent("chan-1", "user-1")).toBeNull();

    storage.close();
  });

  it("seeds expensedesk reimbursement governance for Watson on fresh storage", () => {
    const { storage, dir } = createStorage();
    storage.close();

    const db = new DatabaseSync(path.join(dir, "tango.sqlite"), { readonly: true });
    const tool = db.prepare(
      "SELECT id, access_type FROM governance_tools WHERE id = 'expense_reimbursement'",
    ).get() as { id: string; access_type: string } | undefined;
    const permission = db.prepare(
      "SELECT principal_id, tool_id, access_level FROM permissions WHERE principal_id = 'worker:personal-assistant' AND tool_id = 'expense_reimbursement'",
    ).get() as { principal_id: string; tool_id: string; access_level: string } | undefined;

    expect(tool).toEqual({ id: "expense_reimbursement", access_type: "write" });
    expect(permission).toEqual({
      principal_id: "worker:personal-assistant",
      tool_id: "expense_reimbursement",
      access_level: "write",
    });

    db.close();
  });

  it("seeds high-level docs and nutrition executor governance on fresh storage", () => {
    const { storage, dir } = createStorage();
    storage.close();

    const db = new DatabaseSync(path.join(dir, "tango.sqlite"), { readonly: true });
    const nutritionTool = db.prepare(
      "SELECT id, access_type FROM governance_tools WHERE id = 'nutrition_log_items'",
    ).get() as { id: string; access_type: string } | undefined;
    const nutritionPermission = db.prepare(
      "SELECT principal_id, tool_id, access_level FROM permissions WHERE principal_id = 'worker:nutrition-logger' AND tool_id = 'nutrition_log_items'",
    ).get() as { principal_id: string; tool_id: string; access_level: string } | undefined;
    const docsTool = db.prepare(
      "SELECT id, access_type FROM governance_tools WHERE id = 'gog_docs_update_tab'",
    ).get() as { id: string; access_type: string } | undefined;
    const docsPermission = db.prepare(
      "SELECT principal_id, tool_id, access_level FROM permissions WHERE principal_id = 'worker:personal-assistant' AND tool_id = 'gog_docs_update_tab'",
    ).get() as { principal_id: string; tool_id: string; access_level: string } | undefined;

    expect(nutritionTool).toEqual({ id: "nutrition_log_items", access_type: "write" });
    expect(nutritionPermission).toEqual({
      principal_id: "worker:nutrition-logger",
      tool_id: "nutrition_log_items",
      access_level: "write",
    });
    expect(docsTool).toEqual({ id: "gog_docs_update_tab", access_type: "write" });
    expect(docsPermission).toEqual({
      principal_id: "worker:personal-assistant",
      tool_id: "gog_docs_update_tab",
      access_level: "write",
    });

    db.close();
  });

  it("seeds Jules wellness worker browser access and parent assignment", () => {
    const { storage, dir } = createStorage();
    storage.close();

    const db = new DatabaseSync(path.join(dir, "tango.sqlite"), { readonly: true });
    const checker = new GovernanceChecker(db);

    for (const workerId of [
      "worker:nutrition-logger",
      "worker:recipe-librarian",
      "worker:health-analyst",
    ]) {
      const principal = db.prepare(
        "SELECT id, parent_id FROM principals WHERE id = ?",
      ).get(workerId) as { id: string; parent_id: string } | undefined;
      expect(principal).toEqual({
        id: workerId,
        parent_id: "agent:jules",
      });
      expect(checker.hasPermission(workerId, "browser", "write")).toBe(true);
      expect(checker.hasPermission(workerId, "exa_search", "read")).toBe(true);
      expect(checker.hasPermission(workerId, "exa_answer", "read")).toBe(true);
    }

    const workoutRecorder = db.prepare(
      "SELECT id, parent_id FROM principals WHERE id = 'worker:workout-recorder'",
    ).get() as { id: string; parent_id: string } | undefined;
    expect(workoutRecorder).toEqual({
      id: "worker:workout-recorder",
      parent_id: "agent:malibu",
    });

    db.close();
  });

  it("migrates legacy governance databases that do not have user:owner before Wellness seeds", () => {
    const { storage, dir } = createStorage();
    storage.close();

    const dbPath = path.join(dir, "tango.sqlite");
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      PRAGMA foreign_keys = OFF;

      UPDATE principals
      SET parent_id = 'agent:malibu'
      WHERE id IN (
        'worker:nutrition-logger',
        'worker:health-analyst',
        'worker:recipe-librarian'
      );

      DELETE FROM principals
      WHERE id IN ('worker:activity-tracker', 'agent:jules', 'user:owner');

      PRAGMA user_version = 38;
      PRAGMA foreign_keys = ON;
    `);
    legacyDb.close();

    const migrated = new TangoStorage(dbPath);
    migrated.close();

    const db = new DatabaseSync(dbPath, { readonly: true });
    const owner = db.prepare(
      "SELECT id, type FROM principals WHERE id = 'user:owner'",
    ).get() as { id: string; type: string } | undefined;
    const wellness = db.prepare(
      "SELECT id, parent_id FROM principals WHERE id = 'agent:jules'",
    ).get() as { id: string; parent_id: string } | undefined;
    const activityTracker = db.prepare(
      "SELECT id, parent_id FROM principals WHERE id = 'worker:activity-tracker'",
    ).get() as { id: string; parent_id: string } | undefined;
    const presencePermission = db.prepare(
      "SELECT principal_id, tool_id, access_level FROM permissions WHERE principal_id = 'agent:jules' AND tool_id = 'wellnessdb_log_presence'",
    ).get() as { principal_id: string; tool_id: string; access_level: string } | undefined;
    const foreignKeyFailures = db.prepare("PRAGMA foreign_key_check;").all();

    expect(owner).toEqual({ id: "user:owner", type: "user" });
    expect(wellness).toEqual({ id: "agent:jules", parent_id: "user:owner" });
    expect(activityTracker).toEqual({
      id: "worker:activity-tracker",
      parent_id: "agent:jules",
    });
    expect(presencePermission).toEqual({
      principal_id: "agent:jules",
      tool_id: "wellnessdb_log_presence",
      access_level: "write",
    });
    expect(foreignKeyFailures).toEqual([]);

    db.close();
  });

  it("seeds Papa study-assistant governance with read-only email", () => {
    const { storage, dir } = createStorage();
    storage.close();

    const db = new DatabaseSync(path.join(dir, "tango.sqlite"), { readonly: true });
    const principal = db.prepare(
      "SELECT id, parent_id FROM principals WHERE id = 'worker:study-assistant'",
    ).get() as { id: string; parent_id: string } | undefined;
    const emailPermission = db.prepare(
      "SELECT principal_id, tool_id, access_level FROM permissions WHERE principal_id = 'worker:study-assistant' AND tool_id = 'gog_email'",
    ).get() as { principal_id: string; tool_id: string; access_level: string } | undefined;
    const readingLibraryTool = db.prepare(
      "SELECT id, access_type FROM governance_tools WHERE id = 'study_library'",
    ).get() as { id: string; access_type: string } | undefined;
    const checker = new GovernanceChecker(db);

    expect(principal).toEqual({
      id: "worker:study-assistant",
      parent_id: "agent:papa",
    });
    expect(emailPermission).toEqual({
      principal_id: "worker:study-assistant",
      tool_id: "gog_email",
      access_level: "read",
    });
    expect(readingLibraryTool).toEqual({
      id: "study_library",
      access_type: "write",
    });
    expect(checker.hasPermission("worker:study-assistant", "gog_email", "read")).toBe(true);
    expect(checker.hasPermission("worker:study-assistant", "gog_email", "write")).toBe(false);
    expect(checker.hasPermission("worker:study-assistant", "study_library", "write")).toBe(true);
    expect(checker.hasPermission("worker:study-assistant", "obsidian", "write")).toBe(true);
    expect(checker.hasPermission("worker:study-assistant", "browser", "write")).toBe(true);
    expect(checker.hasPermission("worker:study-assistant", "onepassword", "read")).toBe(true);

    db.close();
  });

  it("seeds Kilo governance with ledger access", () => {
    const { storage, dir } = createStorage();
    storage.close();

    const db = new DatabaseSync(path.join(dir, "tango.sqlite"), { readonly: true });
    const checker = new GovernanceChecker(db);
    const principal = db.prepare(
      "SELECT id, parent_id FROM principals WHERE id = 'worker:kilo'",
    ).get() as { id: string; parent_id: string } | undefined;
    const permission = db.prepare(
      "SELECT principal_id, tool_id, access_level FROM permissions WHERE principal_id = 'worker:kilo' AND tool_id = 'kilo_ledger'",
    ).get() as { principal_id: string; tool_id: string; access_level: string } | undefined;

    expect(principal).toEqual({
      id: "worker:kilo",
      parent_id: "agent:kilo",
    });
    expect(permission).toEqual({
      principal_id: "worker:kilo",
      tool_id: "kilo_ledger",
      access_level: "write",
    });
    expect(checker.hasPermission("worker:kilo", "kilo_ledger", "read")).toBe(true);
    expect(checker.hasPermission("worker:kilo", "kilo_ledger", "write")).toBe(true);

    db.close();
  });

  it("seeds read-only email tool governance for triage workers (v48)", () => {
    const { storage, dir } = createStorage();
    storage.close();

    const db = new DatabaseSync(path.join(dir, "tango.sqlite"), { readonly: true });
    const checker = new GovernanceChecker(db);
    const tool = db.prepare(
      "SELECT id, access_type FROM governance_tools WHERE id = 'email_inbox_scan'",
    ).get() as { id: string; access_type: string } | undefined;

    expect(tool).toEqual({ id: "email_inbox_scan", access_type: "read" });
    for (const workerId of ["worker:personal-assistant", "worker:watson-ollama"]) {
      expect(checker.hasPermission(workerId, "email_inbox_scan", "read")).toBe(true);
      expect(checker.hasPermission(workerId, "email_search", "read")).toBe(true);
      expect(checker.hasPermission(workerId, "email_thread_brief", "read")).toBe(true);
      expect(checker.hasPermission(workerId, "email_inbox_scan", "write")).toBe(false);
    }

    db.close();
  });

  it("seeds notion write governance for research and personal assistants (v49)", () => {
    const { storage, dir } = createStorage();
    storage.close();

    const db = new DatabaseSync(path.join(dir, "tango.sqlite"), { readonly: true });
    const checker = new GovernanceChecker(db);
    expect(checker.hasPermission("worker:research-assistant", "notion", "write")).toBe(true);
    expect(checker.hasPermission("worker:personal-assistant", "notion", "write")).toBe(true);
    expect(checker.hasPermission("worker:sierra-ollama", "notion", "write")).toBe(false);
    db.close();
  });

  it("seeds route governance for Sierra travel workers and retires osrm_route", () => {
    const { storage, dir } = createStorage();
    storage.close();

    const db = new DatabaseSync(path.join(dir, "tango.sqlite"), { readonly: true });
    const checker = new GovernanceChecker(db);
    const drivingTool = db.prepare(
      "SELECT id, access_type FROM governance_tools WHERE id = 'driving_route'",
    ).get() as { id: string; access_type: string } | undefined;
    const walkingTool = db.prepare(
      "SELECT id, access_type FROM governance_tools WHERE id = 'walking_route'",
    ).get() as { id: string; access_type: string } | undefined;
    const retired = db.prepare(
      "SELECT id FROM governance_tools WHERE id = 'osrm_route'",
    ).get();
    const clonePrincipal = db.prepare(
      "SELECT id, parent_id FROM principals WHERE id = 'worker:sierra-ollama'",
    ).get() as { id: string; parent_id: string } | undefined;

    expect(drivingTool).toEqual({ id: "driving_route", access_type: "read" });
    expect(walkingTool).toEqual({ id: "walking_route", access_type: "read" });
    expect(retired).toBeUndefined();
    expect(clonePrincipal).toEqual({
      id: "worker:sierra-ollama",
      parent_id: "agent:sierra-ollama",
    });
    expect(checker.hasPermission("worker:research-assistant", "driving_route", "read")).toBe(true);
    expect(checker.hasPermission("worker:research-assistant", "walking_route", "read")).toBe(true);
    expect(checker.hasPermission("worker:research-coordinator", "driving_route", "read")).toBe(true);
    expect(checker.hasPermission("worker:research-coordinator", "walking_route", "read")).toBe(true);
    expect(checker.hasPermission("worker:sierra-ollama", "driving_route", "read")).toBe(true);
    expect(checker.hasPermission("worker:sierra-ollama", "walking_route", "read")).toBe(true);
    expect(checker.hasPermission("worker:sierra-ollama", "driving_route", "write")).toBe(false);
    expect(checker.hasPermission("worker:sierra-ollama", "walking_route", "write")).toBe(false);
    expect(checker.hasPermission("worker:sierra-ollama", "osrm_route", "read")).toBe(false);

    db.close();
  });

  it("seeds paper_print governance for Sierra travel document workflows", () => {
    const { storage, dir } = createStorage();
    storage.close();

    const db = new DatabaseSync(path.join(dir, "tango.sqlite"), { readonly: true });
    const checker = new GovernanceChecker(db);
    const tool = db.prepare(
      "SELECT id, domain, access_type FROM governance_tools WHERE id = 'paper_print'",
    ).get() as { id: string; domain: string; access_type: string } | undefined;

    expect(tool).toEqual({ id: "paper_print", domain: "research", access_type: "write" });
    expect(checker.hasPermission("worker:research-assistant", "paper_print", "write")).toBe(true);
    expect(checker.hasPermission("worker:sierra-ollama", "paper_print", "write")).toBe(true);

    db.close();
  });

  it("seeds local_business_search governance for Sierra local research", () => {
    const { storage, dir } = createStorage();
    storage.close();

    const db = new DatabaseSync(path.join(dir, "tango.sqlite"), { readonly: true });
    const checker = new GovernanceChecker(db);
    const tool = db.prepare(
      "SELECT id, domain, access_type FROM governance_tools WHERE id = 'local_business_search'",
    ).get() as { id: string; domain: string; access_type: string } | undefined;

    expect(tool).toEqual({ id: "local_business_search", domain: "research", access_type: "read" });
    expect(checker.hasPermission("worker:research-assistant", "local_business_search", "read")).toBe(true);
    expect(checker.hasPermission("worker:sierra-ollama", "local_business_search", "read")).toBe(true);
    expect(checker.hasPermission("worker:research-coordinator", "local_business_search", "read")).toBe(true);
    expect(checker.hasPermission("worker:sierra-ollama", "local_business_search", "write")).toBe(false);

    db.close();
  });

  it("moves Walmart shopping governance from Sierra to Foxtrot", () => {
    const { storage, dir } = createStorage();
    storage.close();

    const db = new DatabaseSync(path.join(dir, "tango.sqlite"), { readonly: true });
    const checker = new GovernanceChecker(db);
    const tool = db.prepare(
      "SELECT id, domain, access_type FROM governance_tools WHERE id = 'walmart'",
    ).get() as { id: string; domain: string; access_type: string } | undefined;

    expect(tool).toEqual({ id: "walmart", domain: "shopping", access_type: "write" });
    expect(checker.hasPermission("worker:foxtrot", "walmart", "write")).toBe(true);
    expect(checker.hasPermission("worker:foxtrot-ollama", "walmart", "write")).toBe(true);
    expect(checker.hasPermission("worker:research-assistant", "walmart", "write")).toBe(false);
    expect(checker.hasPermission("worker:research-coordinator", "walmart", "write")).toBe(false);
    expect(checker.hasPermission("worker:sierra-ollama", "walmart", "write")).toBe(false);

    db.close();
  });

  it("lists recoverable discord inbound messages that never reached execution", () => {
    const { storage } = createStorage();
    storage.bootstrapSessions([
      {
        id: "project:wellness",
        type: "project",
        agent: "malibu",
        channels: ["discord:wellness"],
      },
    ]);

    const recoverableId = storage.insertMessage({
      sessionId: "project:wellness",
      agentId: "malibu",
      direction: "inbound",
      source: "discord",
      discordMessageId: "msg-1",
      discordChannelId: "chan-1",
      discordUserId: "user-1",
      discordUsername: "alice",
      content: "Let's log breakfast.",
      metadata: { listenOnly: false, targetAgentId: "malibu" },
    });
    const processedId = storage.insertMessage({
      sessionId: "project:wellness",
      agentId: "malibu",
      direction: "inbound",
      source: "discord",
      discordMessageId: "msg-2",
      discordChannelId: "chan-1",
      discordUserId: "user-1",
      discordUsername: "alice",
      content: "What have I eaten today?",
      metadata: { listenOnly: false, targetAgentId: "malibu" },
    });
    storage.insertModelRun({
      sessionId: "project:wellness",
      agentId: "malibu",
      providerName: "codex",
      conversationKey: "project:wellness:malibu",
      requestMessageId: processedId,
    });
    const supersededId = storage.insertMessage({
      sessionId: "project:wellness",
      agentId: "malibu",
      direction: "inbound",
      source: "discord",
      discordMessageId: "msg-2a",
      discordChannelId: "chan-1",
      discordUserId: "user-1",
      discordUsername: "alice",
      content: "Log my protein yogurt bowl.",
      metadata: { listenOnly: false, targetAgentId: "malibu" },
    });
    const processedDuplicateId = storage.insertMessage({
      sessionId: "project:wellness",
      agentId: "malibu",
      direction: "inbound",
      source: "discord",
      discordMessageId: "msg-2b",
      discordChannelId: "chan-1",
      discordUserId: "user-1",
      discordUsername: "alice",
      content: "Log my protein yogurt bowl.",
      metadata: { listenOnly: false, targetAgentId: "malibu" },
    });
    storage.insertModelRun({
      sessionId: "project:wellness",
      agentId: "malibu",
      providerName: "codex",
      conversationKey: "project:wellness:malibu",
      requestMessageId: processedDuplicateId,
    });
    const deadLetterId = storage.insertMessage({
      sessionId: "project:wellness",
      agentId: "malibu",
      direction: "inbound",
      source: "discord",
      discordMessageId: "msg-3",
      discordChannelId: "chan-1",
      discordUserId: "user-1",
      discordUsername: "alice",
      content: "Do the thing again.",
      metadata: { listenOnly: false, targetAgentId: "malibu" },
    });
    storage.insertDeadLetter({
      sessionId: "project:wellness",
      agentId: "malibu",
      providerName: "codex",
      conversationKey: "project:wellness:malibu",
      requestMessageId: deadLetterId,
      promptText: "Do the thing again.",
      lastErrorMessage: "interrupted",
    });

    const recoverable = storage.listRecoverableDiscordInboundMessages({
      minAgeMinutes: 0,
      maxAgeMinutes: 60,
      limit: 10,
    });

    expect(recoverable.map((message) => message.id)).toEqual([recoverableId]);
    expect(recoverable.some((message) => message.id === supersededId)).toBe(false);
    expect(recoverable[0]?.discordMessageId).toBe("msg-1");
    expect(recoverable[0]?.content).toBe("Let's log breakfast.");

    storage.close();
  });

  it("preserves explicit memory timestamps and can look up by source ref", () => {
    const { storage } = createStorage();
    storage.bootstrapSessions([
      {
        id: "tango-default",
        type: "persistent",
        agent: "dispatch",
        channels: ["discord:default"]
      }
    ]);

    const memoryId = storage.insertMemory({
      sessionId: "tango-default",
      agentId: "watson",
      source: "backfill",
      content: "Imported memory from a prior transcript.",
      sourceRef: "import:/tmp/transcript#1",
      createdAt: "2026-02-15T08:30:00.000Z",
      lastAccessedAt: "2026-02-16T09:45:00.000Z",
      metadata: { imported: true },
    });

    const stored = storage.getMemory(memoryId);
    expect(stored?.createdAt).toBe("2026-02-15T08:30:00.000Z");
    expect(stored?.lastAccessedAt).toBe("2026-02-16T09:45:00.000Z");

    const lookedUp = storage.findMemoryBySourceRef("import:/tmp/transcript#1", "backfill");
    expect(lookedUp?.id).toBe(memoryId);

    storage.close();
  });

  it("upserts, lists, touches, and expires active context items by scope", () => {
    const { storage } = createStorage();

    const globalItem = storage.upsertActiveContextItem({
      key: "standing-note",
      kind: "note",
      summary: "Applies anywhere for this user.",
      scope: { userId: "user:owner" },
    });
    const scopedItem = storage.upsertActiveContextItem({
      key: "current-plan",
      kind: "plan",
      title: "Current plan",
      summary: "Finish the generic active-context slice.",
      keyFacts: ["Render before retrieved memories."],
      sourceRefs: ["linear:TANGO-123"],
      scope: {
        userId: "user:owner",
        agentId: "watson",
        channelId: "discord:default",
        topicId: "topic:memory",
        projectId: "project:tango",
      },
      metadata: { owner: "codex" },
    });
    storage.upsertActiveContextItem({
      key: "other-channel",
      kind: "task",
      summary: "Should not match this channel.",
      scope: { userId: "user:owner", channelId: "discord:other" },
    });

    const items = storage.listActiveContextItems({
      scope: {
        userId: "user:owner",
        agentId: "watson",
        channelId: "discord:default",
        topicId: "topic:memory",
        projectId: "project:tango",
      },
      limit: 10,
    });
    expect(items.map((item) => item.id).sort((a, b) => a - b)).toEqual([globalItem.id, scopedItem.id]);
    expect(items.find((item) => item.id === scopedItem.id)).toMatchObject({
      key: "current-plan",
      kind: "plan",
      title: "Current plan",
      keyFacts: ["Render before retrieved memories."],
      sourceRefs: ["linear:TANGO-123"],
      metadata: { owner: "codex" },
    });

    const updated = storage.upsertActiveContextItem({
      key: "current-plan",
      kind: "decision",
      summary: "Active context is first-class warm-start state.",
      scope: {
        userId: "user:owner",
        agentId: "watson",
        channelId: "discord:default",
        topicId: "topic:memory",
        projectId: "project:tango",
      },
    });
    expect(updated.id).toBe(scopedItem.id);
    expect(updated.kind).toBe("decision");

    storage.touchActiveContextItems([scopedItem.id]);
    expect(storage.listActiveContextItems({ scope: { userId: "user:owner" }, limit: 10 })
      .find((item) => item.id === scopedItem.id)?.accessCount).toBe(1);

    storage.upsertActiveContextItem({
      key: "expired",
      kind: "other",
      summary: "Already expired.",
      scope: { userId: "user:owner" },
      expiresAt: "2026-03-10 08:00:00",
    });
    expect(storage.expireActiveContextItems("2026-03-10 09:00:00")).toBe(1);
    expect(storage.listActiveContextItems({ scope: { userId: "user:owner" }, now: "2026-03-10 09:00:00" })
      .some((item) => item.key === "expired")).toBe(false);

    storage.close();
  });

  it("creates, partially updates, and lists project_state heads", () => {
    const { storage } = createStorage();

    const created = storage.upsertProjectState({
      projectId: "project:italy-trip",
      title: "Italy Motorcycle Trip",
      status: "active",
      quickRead: "Planning the launch route; vendor decision open.",
      obsidianPath: "Italy Motorcycle Trip June 2026.md",
      templateId: "trip",
      leadAgentId: "sierra",
    });
    expect(created.projectId).toBe("project:italy-trip");
    expect(created.title).toBe("Italy Motorcycle Trip");
    expect(created.quickRead).toContain("vendor");
    expect(created.lastSavedAt).toBeNull();

    // Partial update: only status + quickRead change; title/path/agent preserved.
    const updated = storage.upsertProjectState({
      projectId: "project:italy-trip",
      status: "planning",
      quickRead: "Locked +2 days; Three Peaks gravel loop added.",
      markSaved: true,
    });
    expect(updated.status).toBe("planning");
    expect(updated.title).toBe("Italy Motorcycle Trip");
    expect(updated.obsidianPath).toBe("Italy Motorcycle Trip June 2026.md");
    expect(updated.leadAgentId).toBe("sierra");
    expect(updated.quickRead).toContain("Three Peaks");
    expect(updated.lastSavedAt).not.toBeNull();

    // prevSessionId set on save powers session chaining; status preserved.
    const chained = storage.upsertProjectState({
      projectId: "project:italy-trip",
      prevSessionId: "session-abc-123",
    });
    expect(chained.prevSessionId).toBe("session-abc-123");
    expect(chained.status).toBe("planning");

    storage.upsertProjectState({ projectId: "project:pnw", title: "PNW Loop", status: "active" });

    expect(storage.getProjectState("project:italy-trip")?.title).toBe("Italy Motorcycle Trip");
    expect(storage.getProjectState("missing")).toBeUndefined();

    expect(storage.listProjectStates({ status: "active" }).map((p) => p.projectId)).toEqual([
      "project:pnw",
    ]);
    expect(storage.listProjectStates({}).length).toBe(2);

    storage.close();
  });

  it("tracks obsidian index entries and can replace file-scoped memories", () => {
    const { storage } = createStorage();

    storage.insertMemory({
      source: "obsidian",
      content: "Obsidian chunk one",
      sourceRef: "obsidian:/tmp/note.md#1",
    });
    storage.insertMemory({
      source: "obsidian",
      content: "Obsidian chunk two",
      sourceRef: "obsidian:/tmp/note.md#2",
    });

    storage.upsertObsidianIndexEntry({
      filePath: "/tmp/note.md",
      fileHash: "hash-1",
      chunkCount: 2,
      lastIndexedAt: "2026-03-10T12:00:00.000Z",
    });

    expect(storage.getObsidianIndexEntry("/tmp/note.md")).toMatchObject({
      filePath: "/tmp/note.md",
      fileHash: "hash-1",
      chunkCount: 2,
    });

    expect(storage.deleteMemoriesBySourceRefPrefix("obsidian", "obsidian:/tmp/note.md#")).toBe(2);
    expect(storage.listMemories({ source: "obsidian", limit: 10 })).toHaveLength(0);

    storage.upsertObsidianIndexEntry({
      filePath: "/tmp/note.md",
      fileHash: "hash-2",
      chunkCount: 1,
    });
    expect(storage.listObsidianIndexEntries()).toHaveLength(1);
    expect(storage.getObsidianIndexEntry("/tmp/note.md")).toMatchObject({
      fileHash: "hash-2",
      chunkCount: 1,
    });
    expect(storage.deleteObsidianIndexEntry("/tmp/note.md")).toBe(true);
    expect(storage.getObsidianIndexEntry("/tmp/note.md")).toBeNull();

    storage.close();
  });

  it("persists focused topic state per channel", () => {
    const { storage } = createStorage();
    const topic = storage.upsertTopic({
      channelKey: "discord:general",
      slug: "auth-redesign",
      title: "auth redesign",
      leadAgentId: "watson"
    });

    storage.setFocusedTopicForChannel("discord:general", topic.id);

    expect(storage.getFocusedTopicRecordForChannel("discord:general")).toMatchObject({
      channelKey: "discord:general",
      topicId: topic.id
    });
    expect(storage.getFocusedTopicForChannel("discord:general")?.title).toBe("auth redesign");

    storage.setFocusedTopicForChannel("discord:general", null);

    expect(storage.getFocusedTopicRecordForChannel("discord:general")).toMatchObject({
      channelKey: "discord:general",
      topicId: null
    });
    expect(storage.getFocusedTopicForChannel("discord:general")).toBeNull();

    storage.close();
  });

  it("persists focused project state per channel", () => {
    const { storage } = createStorage();

    storage.setFocusedProjectForChannel("discord:general", "tango");

    expect(storage.getFocusedProjectRecordForChannel("discord:general")).toMatchObject({
      channelKey: "discord:general",
      projectId: "tango"
    });
    expect(storage.getFocusedProjectIdForChannel("discord:general")).toBe("tango");

    storage.setFocusedProjectForChannel("discord:general", null);

    expect(storage.getFocusedProjectRecordForChannel("discord:general")).toMatchObject({
      channelKey: "discord:general",
      projectId: null
    });
    expect(storage.getFocusedProjectIdForChannel("discord:general")).toBeNull();

    storage.close();
  });

  it("persists deterministic turn records with structured receipts", () => {
    const { storage } = createStorage();
    storage.bootstrapSessions([
      {
        id: "project:wellness",
        type: "project",
        agent: "malibu",
        channels: ["discord:wellness"],
      },
    ]);

    const requestMessageId = storage.insertMessage({
      sessionId: "project:wellness",
      agentId: "malibu",
      direction: "inbound",
      source: "discord",
      content: "Log two eggs and toast for breakfast",
    });
    const responseMessageId = storage.insertMessage({
      sessionId: "project:wellness",
      agentId: "malibu",
      providerName: "codex",
      direction: "outbound",
      source: "tango",
      visibility: "public",
      content: "Logged breakfast: two eggs and toast.",
    });
    const modelRunId = storage.insertModelRun({
      sessionId: "project:wellness",
      agentId: "malibu",
      providerName: "codex",
      conversationKey: "project:wellness:malibu",
      model: "gpt-5.4",
      requestMessageId,
      responseMessageId,
    });
    const classifierModelRunId = storage.insertModelRun({
      sessionId: "project:wellness",
      agentId: "malibu",
      providerName: "claude-oauth",
      conversationKey: "project:wellness:malibu",
      model: "claude-sonnet-4-6",
      responseMode: "deterministic-intent-classifier",
      requestMessageId,
    });

    const deterministicTurnId = storage.insertDeterministicTurn({
      sessionId: "project:wellness",
      agentId: "malibu",
      conversationKey: "project:wellness:malibu",
      initiatingPrincipalId: "user:user-1",
      leadAgentPrincipalId: "agent:malibu",
      projectId: "wellness",
      intentIds: ["nutrition.log_food"],
      intentJson: [
        {
          id: "intent-1",
          intentId: "nutrition.log_food",
          entities: {
            items: ["two eggs", "toast"],
            meal: "breakfast",
          },
        },
      ],
      intentModelRunId: classifierModelRunId,
      routeOutcome: "executed",
      fallbackReason: null,
      executionPlanJson: {
        steps: [
          {
            id: "step-1",
            workerId: "nutrition-logger",
          },
        ],
      },
      completedStepCount: 1,
      failedStepCount: 0,
      hasWriteOperations: true,
      workerIds: ["nutrition-logger"],
      delegationChain: ["user:user-1", "agent:malibu", "worker:nutrition-logger"],
      receiptsJson: [
        {
          stepId: "step-1",
          workerId: "nutrition-logger",
          status: "completed",
          hasWriteOperations: true,
          warnings: [],
        },
      ],
      narrationProvider: "codex",
      narrationModel: "gpt-5.4",
      narrationLatencyMs: 1200,
      narrationRetried: false,
      narrationModelRunId: modelRunId,
      intentLatencyMs: 85,
      routeLatencyMs: 5,
      executionLatencyMs: 430,
      totalLatencyMs: 1200,
      requestMessageId,
      responseMessageId,
    });

    const stored = storage.getDeterministicTurn(deterministicTurnId);
    expect(stored).toMatchObject({
      id: deterministicTurnId,
      sessionId: "project:wellness",
      agentId: "malibu",
      conversationKey: "project:wellness:malibu",
      projectId: "wellness",
      intentCount: 1,
      intentIds: ["nutrition.log_food"],
      intentModelRunId: classifierModelRunId,
      routeOutcome: "executed",
      fallbackReason: null,
      stepCount: 1,
      completedStepCount: 1,
      failedStepCount: 0,
      hasWriteOperations: true,
      workerIds: ["nutrition-logger"],
      narrationProvider: "codex",
      narrationModelRunId: modelRunId,
      requestMessageId,
      responseMessageId,
    });
    expect(stored?.intentJson).toEqual([
      {
        id: "intent-1",
        intentId: "nutrition.log_food",
        entities: {
          items: ["two eggs", "toast"],
          meal: "breakfast",
        },
      },
    ]);
    expect(stored?.receiptsJson).toEqual([
      {
        stepId: "step-1",
        workerId: "nutrition-logger",
        status: "completed",
        hasWriteOperations: true,
        warnings: [],
      },
    ]);

    storage.close();
  });

  it("returns the latest deterministic turn for a conversation", () => {
    const { storage } = createStorage();
    storage.bootstrapSessions([
      {
        id: "topic:docs",
        type: "topic",
        agent: "watson",
        channels: ["discord:docs"],
      },
    ]);

    storage.insertDeterministicTurn({
      id: "turn-older",
      sessionId: "topic:docs",
      agentId: "watson",
      conversationKey: "topic:docs:watson",
      initiatingPrincipalId: "user:user-1",
      leadAgentPrincipalId: "agent:watson",
      intentIds: ["docs.google_doc_read_or_update"],
      intentJson: [{ intentId: "docs.google_doc_read_or_update", entities: { doc_query: "old-doc" } }],
      routeOutcome: "executed",
    });

    storage.insertDeterministicTurn({
      id: "turn-newer",
      sessionId: "topic:docs",
      agentId: "watson",
      conversationKey: "topic:docs:watson",
      initiatingPrincipalId: "user:user-1",
      leadAgentPrincipalId: "agent:watson",
      intentIds: ["docs.google_doc_read_or_update"],
      intentJson: [{ intentId: "docs.google_doc_read_or_update", entities: { doc_query: "new-doc" } }],
      routeOutcome: "executed",
    });

    expect(storage.getLatestDeterministicTurnForConversation("topic:docs:watson")?.id).toBe("turn-newer");

    storage.close();
  });

  it("persists sub-agent runs for observability", () => {
    const { storage } = createStorage();
    storage.bootstrapSessions([
      {
        id: "sierra-live-deterministic",
        type: "persistent",
        agent: "sierra",
        channels: ["discord:sierra"],
      },
    ]);

    const insertedId = storage.insertSubAgentRun({
      batchId: "batch-1",
      parentSessionId: "sierra-live-deterministic",
      parentAgentId: "sierra",
      conversationKey: "sierra-live-deterministic:sierra",
      coordinatorWorkerId: "research-coordinator",
      roundIndex: 1,
      subTaskId: "pricing",
      providerName: "claude-oauth",
      model: "claude-haiku-4-5-20251001",
      reasoningEffort: "low",
      toolIds: ["exa_search"],
      dependencyIds: [],
      status: "completed",
      durationMs: 420,
      costEstimateUsd: 0.012,
      outputText: "Pricing summary",
      toolCallsJson: [{ name: "mcp__wellness__exa_search" }],
      metadata: {
        attemptedProviders: ["claude-oauth"],
      },
    });

    const listed = storage.listSubAgentRunsForConversation("sierra-live-deterministic:sierra", 10);

    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: insertedId,
      batchId: "batch-1",
      parentSessionId: "sierra-live-deterministic",
      parentAgentId: "sierra",
      conversationKey: "sierra-live-deterministic:sierra",
      coordinatorWorkerId: "research-coordinator",
      roundIndex: 1,
      subTaskId: "pricing",
      providerName: "claude-oauth",
      model: "claude-haiku-4-5-20251001",
      reasoningEffort: "low",
      toolIds: ["exa_search"],
      dependencyIds: [],
      status: "completed",
      durationMs: 420,
      outputText: "Pricing summary",
      metadata: {
        attemptedProviders: ["claude-oauth"],
      },
    });

    storage.close();
  });

  it("upserts and lists channel topics", () => {
    const { storage } = createStorage();
    storage.bootstrapSessions([
      {
        id: "tango-default",
        type: "persistent",
        agent: "dispatch",
        channels: ["discord:default"]
      }
    ]);

    const created = storage.upsertTopic({
      channelKey: "discord:chan-1",
      slug: "auth-redesign",
      title: "Auth Redesign",
      leadAgentId: "watson",
      projectId: "work"
    });

    const updated = storage.upsertTopic({
      channelKey: "discord:chan-1",
      slug: "auth-redesign",
      title: "Auth Redesign v2"
    });

    expect(updated.id).toBe(created.id);
    expect(updated.title).toBe("Auth Redesign v2");
    expect(updated.leadAgentId).toBe("watson");

    const bySlug = storage.getTopicByChannelAndSlug("discord:chan-1", "auth-redesign");
    expect(bySlug?.id).toBe(created.id);

    const listed = storage.listTopicsForChannel("discord:chan-1");
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: created.id,
      slug: "auth-redesign",
      title: "Auth Redesign v2",
      leadAgentId: "watson",
      projectId: "work",
      status: "active"
    });

    storage.close();
  });

  it("can explicitly clear an existing topic project attachment", () => {
    const { storage } = createStorage();

    const created = storage.upsertTopic({
      channelKey: "discord:chan-1",
      slug: "auth-redesign",
      title: "Auth Redesign",
      leadAgentId: "watson",
      projectId: "tango"
    });

    const updated = storage.upsertTopic({
      channelKey: "discord:chan-1",
      slug: "auth-redesign",
      title: "Auth Redesign",
      projectId: null,
      preserveProjectId: false
    });

    expect(updated.id).toBe(created.id);
    expect(updated.projectId).toBeNull();

    storage.close();
  });

  it("persists model run diagnostics", () => {
    const { storage } = createStorage();
    storage.bootstrapSessions([
      {
        id: "tango-default",
        type: "persistent",
        agent: "dispatch",
        channels: ["discord:default"]
      }
    ]);

    const requestMessageId = storage.insertMessage({
      sessionId: "tango-default",
      agentId: "dispatch",
      direction: "inbound",
      source: "discord",
      content: "summarize this",
      visibility: "public"
    });

    const responseMessageId = storage.insertMessage({
      sessionId: "tango-default",
      agentId: "watson",
      providerName: "claude-oauth",
      direction: "outbound",
      source: "tango",
      content: "Summary complete.",
      visibility: "public"
    });

    storage.insertModelRun({
      sessionId: "tango-default",
      agentId: "watson",
      providerName: "claude-oauth",
      conversationKey: "tango-default:watson",
      providerSessionId: "sess-123",
      model: "claude-sonnet-4-6",
      stopReason: "end_turn",
      responseMode: "concise",
      latencyMs: 3500,
      providerDurationMs: 2800,
      providerApiDurationMs: 1700,
      inputTokens: 123,
      outputTokens: 45,
      cacheReadInputTokens: 1000,
      cacheCreationInputTokens: 0,
      totalCostUsd: 0.0042,
      requestMessageId,
      responseMessageId,
      metadata: { testRun: true },
      rawResponse: { type: "result", foo: "bar" }
    });

    const modelRuns = storage.listModelRunsForSession("tango-default", 5);
    expect(modelRuns).toHaveLength(1);
    expect(modelRuns[0]?.responseMode).toBe("concise");
    expect(modelRuns[0]?.inputTokens).toBe(123);
    expect(modelRuns[0]?.rawResponse).toMatchObject({ foo: "bar" });

    storage.close();
  });

  it("persists prompt snapshots, resolves them by run and message, and prunes expired rows", () => {
    const { storage } = createStorage();
    storage.bootstrapSessions([
      {
        id: "tango-default",
        type: "persistent",
        agent: "dispatch",
        channels: ["discord:default"]
      }
    ]);

    const requestMessageId = storage.insertMessage({
      sessionId: "tango-default",
      agentId: "dispatch",
      direction: "inbound",
      source: "discord",
      content: "What did we decide about weekly planning?",
      visibility: "public"
    });
    const responseMessageId = storage.insertMessage({
      sessionId: "tango-default",
      agentId: "watson",
      providerName: "claude-oauth",
      direction: "outbound",
      source: "tango",
      content: "We moved the review to Monday mornings.",
      visibility: "public"
    });

    const modelRunId = storage.insertModelRun({
      sessionId: "tango-default",
      agentId: "watson",
      providerName: "claude-oauth",
      conversationKey: "tango-default:watson",
      responseMode: "concise",
      requestMessageId,
      responseMessageId
    });

    storage.insertPromptSnapshot({
      modelRunId,
      sessionId: "tango-default",
      agentId: "watson",
      providerName: "claude-oauth",
      requestMessageId,
      responseMessageId,
      promptText: "Current user message:\nWhat did we decide about weekly planning?",
      systemPrompt: "You are Watson",
      warmStartPrompt: "retrieved_memories:\n- Weekly review moved to Monday mornings.",
      metadata: {
        turnWarmStartUsed: true,
        warmStartContext: {
          strategy: "session-memory-prompt"
        }
      }
    });

    expect(storage.getPromptSnapshotByModelRunId(modelRunId)).toMatchObject({
      modelRunId,
      requestMessageId,
      responseMessageId,
      providerName: "claude-oauth",
      promptText: "Current user message:\nWhat did we decide about weekly planning?"
    });
    expect(storage.findPromptSnapshotByRequestMessageId(requestMessageId)?.modelRunId).toBe(modelRunId);
    expect(storage.findPromptSnapshotByResponseMessageId(responseMessageId)?.modelRunId).toBe(modelRunId);
    expect(storage.findPromptSnapshotByMessageId(requestMessageId)?.modelRunId).toBe(modelRunId);
    expect(storage.listPromptSnapshotsForSession("tango-default", 5)).toHaveLength(1);

    const expiredRequestMessageId = storage.insertMessage({
      sessionId: "tango-default",
      agentId: "dispatch",
      direction: "inbound",
      source: "discord",
      content: "Old prompt",
      visibility: "public"
    });
    const expiredModelRunId = storage.insertModelRun({
      sessionId: "tango-default",
      agentId: "watson",
      providerName: "claude-oauth",
      conversationKey: "tango-default:watson",
      responseMode: "concise",
      requestMessageId: expiredRequestMessageId
    });

    storage.insertPromptSnapshot({
      modelRunId: expiredModelRunId,
      sessionId: "tango-default",
      agentId: "watson",
      providerName: "claude-oauth",
      requestMessageId: expiredRequestMessageId,
      promptText: "expired prompt",
      expiresAt: "2026-03-10T00:00:00.000Z"
    });

    expect(storage.getPromptSnapshotByModelRunId(expiredModelRunId)).toBeNull();
    expect(storage.listPromptSnapshotsForSession("tango-default", 5)).toHaveLength(1);

    storage.close();
  });

  it("persists and resolves dead letters", () => {
    const { storage } = createStorage();
    storage.bootstrapSessions([
      {
        id: "tango-default",
        type: "persistent",
        agent: "dispatch",
        channels: ["discord:default"]
      }
    ]);

    const requestMessageId = storage.insertMessage({
      sessionId: "tango-default",
      agentId: "dispatch",
      direction: "inbound",
      source: "discord",
      content: "please summarize",
      visibility: "public"
    });

    const deadLetterId = storage.insertDeadLetter({
      sessionId: "tango-default",
      agentId: "watson",
      providerName: "claude-oauth",
      conversationKey: "tango-default:watson",
      requestMessageId,
      promptText: "please summarize",
      systemPrompt: "You are Watson",
      responseMode: "concise",
      lastErrorMessage: "timed out",
      metadata: { phase: "test" }
    });

    const pending = storage.listDeadLetters({ status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe(deadLetterId);
    expect(pending[0]?.status).toBe("pending");
    expect(pending[0]?.failureCount).toBe(1);

    const replayFailureUpdated = storage.recordDeadLetterReplayFailure({
      id: deadLetterId,
      errorMessage: "still timed out",
      metadata: { replayAttempt: 1 }
    });
    expect(replayFailureUpdated).toBe(true);

    const replayedFailure = storage.getDeadLetter(deadLetterId);
    expect(replayedFailure?.failureCount).toBe(2);
    expect(replayedFailure?.replayCount).toBe(1);
    expect(replayedFailure?.lastErrorMessage).toBe("still timed out");

    const responseMessageId = storage.insertMessage({
      sessionId: "tango-default",
      agentId: "watson",
      providerName: "claude-oauth",
      direction: "outbound",
      source: "tango",
      visibility: "internal",
      content: "Summary complete"
    });
    const modelRunId = storage.insertModelRun({
      sessionId: "tango-default",
      agentId: "watson",
      providerName: "claude-oauth",
      conversationKey: "tango-default:watson",
      responseMode: "concise"
    });

    const resolved = storage.resolveDeadLetter({
      id: deadLetterId,
      resolvedMessageId: responseMessageId,
      resolvedModelRunId: modelRunId,
      incrementReplayCount: true,
      metadata: { replaySource: "test" }
    });
    expect(resolved).toBe(true);

    const resolvedEntry = storage.getDeadLetter(deadLetterId);
    expect(resolvedEntry?.status).toBe("resolved");
    expect(resolvedEntry?.replayCount).toBe(2);
    expect(resolvedEntry?.resolvedMessageId).toBe(responseMessageId);
    expect(resolvedEntry?.resolvedModelRunId).toBe(modelRunId);
    expect(resolvedEntry?.resolvedAt).toBeTruthy();

    const unresolved = storage.listDeadLetters({ status: "pending" });
    expect(unresolved).toHaveLength(0);

    storage.close();
  });

  it("supports session summaries, health snapshots, and reset flows", () => {
    const { storage } = createStorage();
    storage.bootstrapSessions([
      {
        id: "tango-default",
        type: "persistent",
        agent: "dispatch",
        channels: ["discord:default"]
      }
    ]);

    storage.upsertProviderSession({
      conversationKey: "tango-default:watson",
      sessionId: "tango-default",
      agentId: "watson",
      providerName: "claude-oauth",
      providerSessionId: "sess-1"
    });

    storage.insertMessage({
      sessionId: "tango-default",
      agentId: "dispatch",
      direction: "inbound",
      source: "discord",
      content: "hello world",
      visibility: "public"
    });

    const modelRunId = storage.insertModelRun({
      sessionId: "tango-default",
      agentId: "watson",
      providerName: "claude-oauth",
      conversationKey: "tango-default:watson",
      responseMode: "concise",
      isError: false
    });
    storage.insertPromptSnapshot({
      modelRunId,
      sessionId: "tango-default",
      agentId: "watson",
      providerName: "claude-oauth",
      promptText: "hello world",
      systemPrompt: "You are Watson"
    });

    storage.insertDeadLetter({
      sessionId: "tango-default",
      agentId: "watson",
      providerName: "claude-oauth",
      conversationKey: "tango-default:watson",
      promptText: "hello world",
      lastErrorMessage: "provider failed"
    });

    const summary = storage.getSessionSummary("tango-default");
    expect(summary).toBeTruthy();
    expect(summary?.messageCount).toBe(1);
    expect(summary?.modelRunCount).toBe(1);
    expect(summary?.providerSessionCount).toBe(1);

    const health = storage.getHealthSnapshot();
    expect(health.status).toBe("healthy");
    expect(health.sessions).toBe(1);
    expect(health.messages).toBe(1);
    expect(health.modelRuns).toBe(1);
    expect(health.providerSessions).toBe(1);
    expect(health.deadLettersTotal).toBe(1);
    expect(health.deadLettersPending).toBe(1);

    const softReset = storage.resetSession("tango-default");
    expect(softReset.deletedProviderSessions).toBe(1);
    expect(softReset.deletedModelRuns).toBe(0);
    expect(softReset.deletedMessages).toBe(0);
    expect(softReset.deletedDeadLetters).toBe(0);
    expect(softReset.deletedPromptSnapshots).toBe(0);

    const hardReset = storage.resetSession("tango-default", { clearHistory: true });
    expect(hardReset.deletedMessages).toBe(1);
    expect(hardReset.deletedModelRuns).toBe(1);
    expect(hardReset.deletedDeadLetters).toBe(1);
    expect(hardReset.deletedPromptSnapshots).toBe(1);

    storage.close();
  });

  it("persists per-session provider overrides and clears provider continuity", () => {
    const { storage } = createStorage();
    storage.bootstrapSessions([
      {
        id: "tango-default",
        type: "persistent",
        agent: "dispatch",
        channels: ["discord:default"]
      }
    ]);

    storage.upsertSessionProviderOverride({
      sessionId: "tango-default",
      agentId: "watson",
      providerName: "codex"
    });

    const override = storage.getSessionProviderOverride("tango-default", "watson");
    expect(override?.providerName).toBe("codex");

    storage.upsertSessionProviderOverride({
      sessionId: "tango-default",
      agentId: "watson",
      providerName: "claude-oauth"
    });

    const updated = storage.getSessionProviderOverride("tango-default", "watson");
    expect(updated?.providerName).toBe("claude-oauth");

    const overrides = storage.listSessionProviderOverrides("tango-default");
    expect(overrides).toHaveLength(1);
    expect(overrides[0]?.agentId).toBe("watson");

    storage.upsertProviderSession({
      conversationKey: "tango-default:watson",
      sessionId: "tango-default",
      agentId: "watson",
      providerName: "claude-oauth",
      providerSessionId: "sess-123"
    });
    expect(storage.getProviderSession("tango-default:watson")?.providerSessionId).toBe("sess-123");
    expect(storage.clearProviderSession("tango-default:watson")).toBe(true);
    expect(storage.getProviderSession("tango-default:watson")).toBeNull();

    expect(storage.clearSessionProviderOverride("tango-default", "watson")).toBe(true);
    expect(storage.getSessionProviderOverride("tango-default", "watson")).toBeNull();

    storage.close();
  });

  it("persists and clears session compaction summaries", () => {
    const { storage } = createStorage();
    storage.bootstrapSessions([
      {
        id: "tango-default",
        type: "persistent",
        agent: "dispatch",
        channels: ["discord:default"]
      }
    ]);

    storage.upsertSessionCompaction({
      sessionId: "tango-default",
      agentId: "watson",
      summaryText: "Compacted history summary",
      compactedTurns: 12
    });

    const summary = storage.getSessionCompaction("tango-default", "watson");
    expect(summary?.summaryText).toContain("Compacted history");
    expect(summary?.compactedTurns).toBe(12);

    expect(storage.clearSessionCompaction("tango-default", "watson")).toBe(true);
    expect(storage.getSessionCompaction("tango-default", "watson")).toBeNull();

    storage.close();
  });

  it("lists provider continuity and recent model runs per conversation", () => {
    const { storage } = createStorage();
    storage.bootstrapSessions([
      {
        id: "tango-default",
        type: "persistent",
        agent: "dispatch",
        channels: ["discord:default"]
      }
    ]);

    storage.upsertProviderSession({
      conversationKey: "tango-default:watson",
      sessionId: "tango-default",
      agentId: "watson",
      providerName: "codex",
      providerSessionId: "thread-1"
    });
    storage.upsertProviderSession({
      conversationKey: "tango-default:watson",
      sessionId: "tango-default",
      agentId: "watson",
      providerName: "claude-oauth",
      providerSessionId: "session-22"
    });

    storage.insertModelRun({
      sessionId: "tango-default",
      agentId: "watson",
      providerName: "codex",
      conversationKey: "tango-default:watson",
      providerSessionId: "thread-1",
      responseMode: "concise",
      metadata: { warmStartUsed: false }
    });
    storage.insertModelRun({
      sessionId: "tango-default",
      agentId: "watson",
      providerName: "claude-oauth",
      conversationKey: "tango-default:watson",
      providerSessionId: "session-22",
      responseMode: "concise",
      metadata: { warmStartUsed: true }
    });

    const providerSessions = storage.listProviderSessionsForConversation("tango-default:watson", 10);
    expect(providerSessions).toHaveLength(2);
    expect(providerSessions.some((row) => row.providerName === "codex")).toBe(true);
    expect(providerSessions.some((row) => row.providerName === "claude-oauth")).toBe(true);

    const runs = storage.listModelRunsForConversation("tango-default:watson", 5);
    expect(runs).toHaveLength(2);
    expect(runs[0]?.providerName).toBe("claude-oauth");
    expect(runs[1]?.providerName).toBe("codex");

    storage.close();
  });

  it("lists only expired stateless provider artifacts for cleanup", () => {
    const { storage } = createStorage();
    storage.bootstrapSessions([
      {
        id: "tango-default",
        type: "persistent",
        agent: "dispatch",
        channels: ["discord:default"]
      }
    ]);

    storage.insertModelRun({
      sessionId: "tango-default",
      agentId: "watson",
      providerName: "claude-oauth",
      conversationKey: "tango-default:watson",
      providerSessionId: "expired-stateless",
      responseMode: "concise",
      metadata: { orchestratorContinuityMode: "stateless" },
      rawResponse: null,
    });
    storage.insertModelRun({
      sessionId: "tango-default",
      agentId: "watson",
      providerName: "claude-oauth",
      conversationKey: "tango-default:watson",
      providerSessionId: "recent-stateless",
      responseMode: "concise",
      metadata: { orchestratorContinuityMode: "stateless" },
      rawResponse: null,
    });
    storage.insertModelRun({
      sessionId: "tango-default",
      agentId: "watson",
      providerName: "claude-oauth",
      conversationKey: "tango-default:watson",
      providerSessionId: "expired-provider",
      responseMode: "concise",
      metadata: { orchestratorContinuityMode: "provider" },
      rawResponse: null,
    });

    storage.getDatabase().prepare(
      `
        UPDATE model_runs
        SET created_at = CASE provider_session_id
          WHEN 'expired-stateless' THEN '2026-03-05T10:00:00.000Z'
          WHEN 'recent-stateless' THEN '2026-03-11T10:00:00.000Z'
          WHEN 'expired-provider' THEN '2026-03-05T10:00:00.000Z'
          ELSE created_at
        END
      `
    ).run();

    const candidates = storage.listProviderArtifactCleanupCandidates({
      olderThan: "2026-03-09T10:00:00.000Z",
      providerNamePrefixes: ["claude"],
      continuityMode: "stateless",
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      providerName: "claude-oauth",
      providerSessionId: "expired-stateless",
      runCount: 1,
    });

    storage.close();
  });

  it("persists conversation memories and pinned facts", () => {
    const { storage } = createStorage();
    storage.bootstrapSessions([
      {
        id: "tango-default",
        type: "persistent",
        agent: "dispatch",
        channels: ["discord:default"]
      }
    ]);

    const memoryId = storage.insertMemory({
      sessionId: "tango-default",
      agentId: "watson",
      source: "conversation",
      content: "User prefers compact daily summaries.",
      importance: 0.8,
      metadata: { keywords: ["daily", "summaries"] }
    });

    storage.upsertPinnedFact({
      scope: "global",
      key: "timezone",
      value: "America/Los_Angeles"
    });
    storage.upsertPinnedFact({
      scope: "agent",
      scopeId: "watson",
      key: "review_style",
      value: "concise"
    });

    const memory = storage.getMemory(memoryId);
    expect(memory?.source).toBe("conversation");
    expect(memory?.importance).toBe(0.8);

    const memories = storage.listMemories({
      sessionId: "tango-default",
      agentId: "watson",
      limit: 10
    });
    expect(memories.some((row) => row.id === memoryId)).toBe(true);

    expect(
      storage.updateMemoryEmbedding({
        memoryId,
        embeddingJson: JSON.stringify([0.25, 0.75]),
        embeddingModel: "deterministic-test"
      })
    ).toBe(true);
    expect(storage.getMemory(memoryId)?.embeddingModel).toBe("deterministic-test");

    storage.touchMemories([memoryId]);
    expect(storage.getMemory(memoryId)?.accessCount).toBe(1);

    const pinnedFacts = storage.listPinnedFactsForContext("tango-default", "watson");
    expect(pinnedFacts).toMatchObject([
      { scope: "agent", key: "review_style", value: "concise" },
      { scope: "global", key: "timezone", value: "America/Los_Angeles" }
    ]);

    expect(storage.deletePinnedFact("agent", "watson", "review_style")).toBe(true);
    expect(
      storage.listPinnedFactsForContext("tango-default", "watson").some((fact) => fact.key === "review_style")
    ).toBe(false);

    storage.close();
  });

  it("lists memories across configured agent aliases", () => {
    const { storage } = createStorage();
    storage.bootstrapSessions([
      {
        id: "tango-default",
        type: "persistent",
        agent: "dispatch",
        channels: ["discord:default"]
      }
    ]);

    const baseId = storage.insertMemory({
      sessionId: "tango-default",
      agentId: "sierra",
      source: "conversation",
      content: "Fuji X100VI camera research.",
    });
    const cloneId = storage.insertMemory({
      sessionId: "tango-default",
      agentId: "sierra-ollama",
      source: "conversation",
      content: "Adapter ring note for the Fuji camera.",
    });
    storage.insertMemory({
      sessionId: "tango-default",
      agentId: "watson",
      source: "conversation",
      content: "Unrelated finance memory.",
    });

    const memories = storage.listMemories({
      sessionId: "tango-default",
      agentIds: ["sierra", "sierra-ollama"],
      limit: 10,
    });

    expect(memories.map((memory) => memory.id).sort((left, right) => left - right)).toEqual([
      baseId,
      cloneId,
    ]);

    storage.close();
  });

  it("stores rolling session summaries per session and agent", () => {
    const { storage } = createStorage();
    storage.bootstrapSessions([
      {
        id: "tango-default",
        type: "persistent",
        agent: "dispatch",
        channels: ["discord:default"]
      }
    ]);

    storage.upsertSessionMemorySummary({
      sessionId: "tango-default",
      agentId: "watson",
      summaryText: "Conversation summary: user asked for a weekly review.",
      tokenCount: 12,
      coversThroughMessageId: 4,
    });
    storage.upsertSessionMemorySummary({
      sessionId: "tango-default",
      agentId: "watson",
      summaryText: "Conversation summary: assistant proposed a lighter format.",
      tokenCount: 10,
      coversThroughMessageId: 8,
    });

    const latest = storage.getLatestSessionMemorySummary("tango-default", "watson");
    expect(latest?.coversThroughMessageId).toBe(8);

    const summaries = storage.listSessionMemorySummaries("tango-default", "watson", 10);
    expect(summaries).toHaveLength(2);
    expect(summaries[0]?.coversThroughMessageId).toBe(8);
    expect(summaries[1]?.coversThroughMessageId).toBe(4);

    storage.close();
  });

  it("claims and resolves voice turn receipts for utterance idempotency", () => {
    const { storage } = createStorage();
    storage.bootstrapSessions([
      {
        id: "voice-main",
        type: "persistent",
        agent: "watson",
        channels: ["voice:main"]
      }
    ]);

    const first = storage.claimVoiceTurnReceipt({
      sessionId: "voice-main",
      agentId: "watson",
      utteranceId: "utt-001",
      metadata: { source: "voice-bridge" }
    });
    expect(first.created).toBe(true);
    expect(first.receipt.status).toBe("processing");

    const duplicate = storage.claimVoiceTurnReceipt({
      sessionId: "voice-main",
      agentId: "watson",
      utteranceId: "utt-001"
    });
    expect(duplicate.created).toBe(false);
    expect(duplicate.receipt.turnId).toBe(first.receipt.turnId);

    const requestMessageId = storage.insertMessage({
      sessionId: "voice-main",
      agentId: "watson",
      direction: "inbound",
      source: "tango",
      visibility: "public",
      content: "hello from call",
      metadata: { utteranceId: "utt-001" }
    });
    const responseMessageId = storage.insertMessage({
      sessionId: "voice-main",
      agentId: "watson",
      direction: "outbound",
      source: "tango",
      visibility: "public",
      content: "hello back",
      metadata: { utteranceId: "utt-001" }
    });
    const modelRunId = storage.insertModelRun({
      sessionId: "voice-main",
      agentId: "watson",
      providerName: "echo",
      conversationKey: "voice-main:watson",
      requestMessageId,
      responseMessageId
    });

    const markedComplete = storage.completeVoiceTurnReceipt({
      turnId: first.receipt.turnId,
      providerName: "echo",
      providerSessionId: "voice-thread-1",
      responseText: "hello back",
      providerUsedFailover: false,
      warmStartUsed: true,
      requestMessageId,
      responseMessageId,
      modelRunId
    });
    expect(markedComplete).toBe(true);

    const completed = storage.getVoiceTurnReceipt("voice-main", "utt-001");
    expect(completed?.status).toBe("completed");
    expect(completed?.responseText).toBe("hello back");
    expect(completed?.providerName).toBe("echo");
    expect(completed?.providerUsedFailover).toBe(false);
    expect(completed?.warmStartUsed).toBe(true);

    const failedClaim = storage.claimVoiceTurnReceipt({
      sessionId: "voice-main",
      agentId: "watson",
      utteranceId: "utt-002"
    });
    const markedFailed = storage.failVoiceTurnReceipt({
      turnId: failedClaim.receipt.turnId,
      errorMessage: "provider timeout"
    });
    expect(markedFailed).toBe(true);
    const failed = storage.getVoiceTurnReceipt("voice-main", "utt-002");
    expect(failed?.status).toBe("failed");
    expect(failed?.errorMessage).toBe("provider timeout");

    storage.close();
  });

  it("persists and lists active tasks with structured context", () => {
    const { storage } = createStorage();
    storage.bootstrapSessions([
      {
        id: "project:wellness",
        type: "project",
        agent: "malibu",
        channels: ["discord:wellness"],
      },
    ]);

    const assistantMessageId = storage.insertMessage({
      sessionId: "project:wellness",
      agentId: "malibu",
      direction: "outbound",
      source: "tango",
      visibility: "public",
      content: "Want me to analyze the last four weeks of TDEE?",
    });

    const taskId = storage.upsertActiveTask({
      sessionId: "project:wellness",
      agentId: "malibu",
      status: "awaiting_user",
      title: "Analyze recent TDEE",
      objective: "Review multi-week TDEE trend and suggest a calorie target.",
      ownerWorkerId: "health-analyst",
      intentIds: ["health.morning_brief"],
      missingSlots: ["days"],
      clarificationQuestion: "How many weeks should I analyze?",
      suggestedNextAction: "Confirm the analysis window.",
      structuredContext: {
        proposedDays: 28,
        source: "assistant-offer",
      },
      sourceKind: "assistant-offer",
      createdByMessageId: assistantMessageId,
      updatedByMessageId: assistantMessageId,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    const stored = storage.getActiveTask(taskId);
    expect(stored).toMatchObject({
      id: taskId,
      sessionId: "project:wellness",
      agentId: "malibu",
      status: "awaiting_user",
      title: "Analyze recent TDEE",
      ownerWorkerId: "health-analyst",
      intentIds: ["health.morning_brief"],
      missingSlots: ["days"],
      clarificationQuestion: "How many weeks should I analyze?",
      suggestedNextAction: "Confirm the analysis window.",
      structuredContext: {
        proposedDays: 28,
        source: "assistant-offer",
      },
    });

    const listed = storage.listActiveTasks({
      sessionId: "project:wellness",
      agentId: "malibu",
      limit: 10,
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(taskId);

    storage.close();
  });

  it("finds open tasks from prior alias sessions using verified source-channel provenance", () => {
    const { storage } = createStorage();
    storage.bootstrapSessions([
      { id: "finance-old", type: "persistent", agent: "foxtrot-ollama", channels: [] },
      { id: "finance-current", type: "persistent", agent: "foxtrot", channels: [] },
      { id: "other-agent", type: "persistent", agent: "watson", channels: [] },
    ]);
    const source = (channel: string, agentId = "foxtrot-ollama", visibility: "public" | "internal" = "public") => storage.insertMessage({
      sessionId: agentId === "watson" ? "other-agent" : "finance-old",
      agentId, discordChannelId: channel, visibility, direction: "outbound", source: "tango",
      content: "Waiting for the existing receipt workflow; do not ask again.",
    });
    const task = (sourceId: number, overrides: Record<string, unknown> = {}) => storage.upsertActiveTask({
      sessionId: "finance-old", agentId: "foxtrot-ollama", status: "awaiting_user",
      title: "Review unresolved receipt", objective: "Wait for receipt evidence", createdByMessageId: sourceId,
      ...overrides,
    });
    const priorTask = task(source("finance-thread"));
    task(source("other-thread"));
    task(source("finance-thread", "foxtrot-ollama", "internal"));
    task(source("finance-thread", "watson"));
    task(source("finance-thread"), { updatedByMessageId: source("other-thread") });
    task(source("finance-thread"), { status: "completed" });
    task(source("finance-thread"), { expiresAt: "2000-01-01T00:00:00.000Z" });
    task(source("finance-thread", "watson"), { agentId: "watson", sessionId: "other-agent" });

    expect(storage.listActiveTasks({ sessionId: "finance-current", agentId: "foxtrot-ollama" })).toEqual([]);
    const tasks = storage.listActiveTasks({ sessionId: "finance-current", agentId: "foxtrot-ollama", sourceChannelId: "finance-thread" });
    expect(tasks.map((row) => row.id)).toEqual([priorTask]);
    expect(tasks[0].sessionId).toBe("finance-old");
    storage.close();
  });

  it("updates and expires active tasks without listing resolved tasks by default", () => {
    const { storage } = createStorage();
    storage.bootstrapSessions([
      {
        id: "project:wellness",
        type: "project",
        agent: "malibu",
        channels: ["discord:wellness"],
      },
    ]);

    const clarificationMessageId = storage.insertMessage({
      sessionId: "project:wellness",
      agentId: "malibu",
      direction: "outbound",
      source: "tango",
      visibility: "public",
      content: "How much pulled pork was in each taco?",
    });
    const followupMessageId = storage.insertMessage({
      sessionId: "project:wellness",
      agentId: "malibu",
      direction: "inbound",
      source: "discord",
      visibility: "public",
      content: "60g per taco",
    });

    const completedTaskId = storage.upsertActiveTask({
      sessionId: "project:wellness",
      agentId: "malibu",
      status: "awaiting_user",
      title: "Fill missing meal portion",
      objective: "Resolve the missing pork portion for dinner logging.",
      intentIds: ["nutrition.log_food"],
      missingSlots: ["portion_grams"],
      clarificationQuestion: "How much pulled pork was in each taco?",
      sourceKind: "clarification",
      createdByMessageId: clarificationMessageId,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(
      storage.updateActiveTaskStatus({
        id: completedTaskId,
        status: "completed",
        updatedByMessageId: followupMessageId,
        structuredContext: {
          resolvedBy: "user-confirmation",
        },
      }),
    ).toBe(true);
    expect(storage.getActiveTask(completedTaskId)).toMatchObject({
      status: "completed",
      updatedByMessageId: followupMessageId,
      structuredContext: {
        resolvedBy: "user-confirmation",
      },
    });
    expect(storage.getActiveTask(completedTaskId)?.resolvedAt).toBeTruthy();

    const expiringTaskId = storage.upsertActiveTask({
      sessionId: "project:wellness",
      agentId: "malibu",
      status: "awaiting_user",
      title: "Review recent TDEE",
      objective: "Analyze recent TDEE trend.",
      intentIds: ["health.morning_brief"],
      sourceKind: "assistant-offer",
      createdByMessageId: clarificationMessageId,
      expiresAt: "2000-01-01T00:00:00.000Z",
    });

    expect(storage.expireStaleActiveTasks()).toBeGreaterThanOrEqual(1);
    expect(storage.getActiveTask(expiringTaskId)?.status).toBe("expired");

    const openTasks = storage.listActiveTasks({
      sessionId: "project:wellness",
      agentId: "malibu",
      limit: 10,
    });
    expect(openTasks).toHaveLength(0);

    const resolvedTasks = storage.listActiveTasks({
      sessionId: "project:wellness",
      agentId: "malibu",
      includeResolved: true,
      limit: 10,
    });
    expect(resolvedTasks.map((task) => task.id)).toEqual(
      expect.arrayContaining([completedTaskId, expiringTaskId]),
    );

    storage.close();
  });

  it("upserts, retrieves, deletes, and counts pending session saves", () => {
    const { storage } = createStorage();

    expect(storage.countPendingSessionSaves()).toBe(0);
    expect(storage.getPendingSessionSave("channel:123")).toBeNull();

    const created = storage.upsertPendingSessionSave({
      conversationKey: "channel:123",
      sessionId: "cod-e",
      agentId: "cod-e",
      requestedByUserId: "user-1",
      trigger: "slash_command",
    });

    expect(created.conversationKey).toBe("channel:123");
    expect(created.sessionId).toBe("cod-e");
    expect(created.agentId).toBe("cod-e");
    expect(created.requestedByUserId).toBe("user-1");
    expect(created.trigger).toBe("slash_command");
    expect(created.requestedAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(storage.countPendingSessionSaves()).toBe(1);

    const updated = storage.upsertPendingSessionSave({
      conversationKey: "channel:123",
      sessionId: "topic:abc",
      agentId: "cod-e",
      requestedByUserId: "user-2",
      trigger: "slash_command",
    });

    expect(updated.sessionId).toBe("topic:abc");
    expect(updated.requestedByUserId).toBe("user-2");
    expect(storage.countPendingSessionSaves()).toBe(1);

    expect(storage.deletePendingSessionSave("channel:123")).toBe(true);
    expect(storage.deletePendingSessionSave("channel:123")).toBe(false);
    expect(storage.countPendingSessionSaves()).toBe(0);

    storage.close();
  });
});

// attachment_update (v0 operator write surface) registers as a catalog-only
// write tool, born ungranted: who holds it is the operator's decision, made
// per install, never applied by a migration.
// (Renumbered from the source chain's 74 onto this chain's tail.)
describe("attachment_update governance registration (migration 70)", () => {
  it("registers the tool as write-access and grants it to no one", () => {
    const { storage } = createStorage();

    const tool = storage
      .getDatabase()
      .prepare("SELECT id, domain, access_type FROM governance_tools WHERE id = 'attachment_update'")
      .get() as { id?: string; domain?: string; access_type?: string } | undefined;
    expect(tool?.id).toBe("attachment_update");
    expect(tool?.domain).toBe("attachments");
    expect(tool?.access_type).toBe("write");

    const grants = storage
      .getDatabase()
      .prepare("SELECT COUNT(*) AS count FROM permissions WHERE tool_id = 'attachment_update'")
      .get() as { count: number };
    expect(grants.count).toBe(0);
  });
});

// attachment_enumerate (exhaustive-by-label read tool). Born UNGRANTED:
// grants are operator decisions, applied per install on the operator's word.
// This test PINS the ungranted state so a future edit cannot silently arm it
// in the migration. (Renumbered from the source chain's 75 onto this chain's tail.)
describe("attachment_enumerate governance registration (migration 71)", () => {
  it("registers the tool as read-access with ZERO grants (born ungranted)", () => {
    const { storage } = createStorage();

    const tool = storage
      .getDatabase()
      .prepare("SELECT id, domain, access_type FROM governance_tools WHERE id = 'attachment_enumerate'")
      .get() as { id?: string; domain?: string; access_type?: string } | undefined;
    expect(tool?.id).toBe("attachment_enumerate");
    expect(tool?.domain).toBe("attachments");
    expect(tool?.access_type).toBe("read");

    const grantCount = storage
      .getDatabase()
      .prepare("SELECT COUNT(*) AS count FROM permissions WHERE tool_id = 'attachment_enumerate'")
      .get() as { count: number };
    expect(grantCount.count).toBe(0);
  });
});

// T-I-035: context-usage snapshots — persisted at the lifecycle write point so
// /tango context and the voice whisper survive RAM wipes.
describe("context usage snapshots (T-I-035)", () => {
  it("the snapshot migration creates the table and lands as the live user_version", () => {
    const { storage, dir } = createStorage();
    storage.close();

    const db = new DatabaseSync(path.join(dir, "tango.sqlite"));
    try {
      const version = db.prepare("PRAGMA user_version;").get() as { user_version: number };
      // Bump alongside the newest entry in MIGRATIONS (86 = conversation revision index).
      expect(version.user_version).toBe(86);
      const table = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'context_usage_snapshots'")
        .get() as { name?: string } | undefined;
      expect(table?.name).toBe("context_usage_snapshots");
    } finally {
      db.close();
    }
  });

  it("upserts keep only the latest reading per conversation+agent", () => {
    const { storage } = createStorage();

    storage.upsertContextUsageSnapshot({
      conversationKey: "thread:123",
      agentId: "alpha",
      fraction: 0.28,
      usedTokens: 56_000,
      contextWindow: 200_000,
      recordedAt: "2026-07-12T10:00:00.000Z",
    });
    storage.upsertContextUsageSnapshot({
      conversationKey: "thread:123",
      agentId: "alpha",
      fraction: 0.31,
      usedTokens: 62_000,
      contextWindow: 200_000,
      recordedAt: "2026-07-12T10:05:00.000Z",
    });

    const row = storage.getContextUsageSnapshot("thread:123", "alpha");
    expect(row).toMatchObject({
      conversationKey: "thread:123",
      agentId: "alpha",
      usedTokens: 62_000,
      contextWindow: 200_000,
      recordedAt: "2026-07-12T10:05:00.000Z",
    });
    expect(row!.fraction).toBeCloseTo(0.31, 4);
  });

  it("defaults recorded_at when the writer omits it", () => {
    const { storage } = createStorage();

    storage.upsertContextUsageSnapshot({
      conversationKey: "channel:456",
      agentId: "beta",
      fraction: 0.46,
      usedTokens: 92_000,
      contextWindow: 200_000,
    });

    const row = storage.getContextUsageSnapshot("channel:456", "beta");
    expect(row?.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("queries across key shapes: exact typed keys plus LIKE voice patterns, agent-filtered, freshest first", () => {
    const { storage } = createStorage();
    const post = "1385000000000000000";

    // typed session for this thread
    storage.upsertContextUsageSnapshot({
      conversationKey: `thread:${post}`,
      agentId: "alpha",
      fraction: 0.28,
      usedTokens: 56_000,
      contextWindow: 200_000,
      recordedAt: "2026-07-12T10:00:00.000Z",
    });
    // voice session in the same post (voice key embeds the channel id)
    storage.upsertContextUsageSnapshot({
      conversationKey: `agent:alpha:discord:channel:${post}:alpha`,
      agentId: "alpha",
      fraction: 0.62,
      usedTokens: 124_000,
      contextWindow: 200_000,
      recordedAt: "2026-07-12T10:04:00.000Z",
    });
    // same post, DIFFERENT agent — must be filtered out
    storage.upsertContextUsageSnapshot({
      conversationKey: `agent:beta:discord:channel:${post}:beta`,
      agentId: "beta",
      fraction: 0.9,
      usedTokens: 180_000,
      contextWindow: 200_000,
      recordedAt: "2026-07-12T10:04:30.000Z",
    });
    // unrelated post — must not match
    storage.upsertContextUsageSnapshot({
      conversationKey: "thread:999",
      agentId: "alpha",
      fraction: 0.11,
      usedTokens: 22_000,
      contextWindow: 200_000,
      recordedAt: "2026-07-12T10:03:00.000Z",
    });

    const rows = storage.queryContextUsageSnapshots({
      agentId: "alpha",
      exactKeys: [`thread:${post}`],
      likePatterns: [`%discord:channel:${post}%`],
    });

    expect(rows.map((row) => row.conversationKey)).toEqual([
      `agent:alpha:discord:channel:${post}:alpha`,
      `thread:${post}`,
    ]);
  });

  it("returns empty for empty patterns instead of matching everything", () => {
    const { storage } = createStorage();
    storage.upsertContextUsageSnapshot({
      conversationKey: "thread:123",
      agentId: "alpha",
      fraction: 0.28,
      usedTokens: 56_000,
      contextWindow: 200_000,
    });

    expect(storage.queryContextUsageSnapshots({ agentId: "alpha" })).toEqual([]);
    expect(
      storage.queryContextUsageSnapshots({ agentId: "alpha", exactKeys: ["  "], likePatterns: [""] }),
    ).toEqual([]);
  });
});


describe("Malibu wellness.db governance (migration 77)", () => {
  it.each([true, false])("upgrades idempotently with Malibu principals present=%s", (present) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-wellness-governance-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "tango.sqlite");
    const initial = new TangoStorage(dbPath);
    const db = initial.getDatabase();
    const missingCatalog = ["wellnessdb_update_product", "wellnessdb_update_supplement",
      "wellnessdb_delete_product", "wellnessdb_delete_supplement"];
    for (const tool of missingCatalog) {
      expect(db.prepare("SELECT domain, access_type FROM governance_tools WHERE id = ?").get(tool))
        .toMatchObject({ domain: "wellness", access_type: "write" });
      db.prepare("DELETE FROM governance_tools WHERE id = ?").run(tool);
    }
    if (present) {
      db.exec(`INSERT INTO principals (id, type, display_name) VALUES
        ('agent:malibu', 'agent', 'Malibu'), ('agent:malibu-ollama', 'agent', 'Malibu Ollama')`);
    }
    db.exec("PRAGMA user_version = 76");
    initial.close();
    for (let attempt = 0; attempt < 2; attempt++) {
      const upgraded = new TangoStorage(dbPath);
      try {
        const upgradedDb = upgraded.getDatabase();
        for (const tool of missingCatalog) {
          expect(upgradedDb.prepare("SELECT domain, access_type FROM governance_tools WHERE id = ?").get(tool))
            .toMatchObject({ domain: "wellness", access_type: "write" });
        }
        for (const principal of ["agent:malibu", "agent:malibu-ollama"]) {
          const grants = upgradedDb.prepare("SELECT tool_id, access_level FROM permissions WHERE principal_id = ? ORDER BY tool_id")
            .all(principal);
          expect(grants).toEqual(present ? [
            { tool_id: "wellnessdb_active_products", access_level: "read" },
            { tool_id: "wellnessdb_add_product", access_level: "write" },
            { tool_id: "wellnessdb_add_recipe", access_level: "write" },
            { tool_id: "wellnessdb_add_recipe_ingredient", access_level: "write" },
            { tool_id: "wellnessdb_archive_recipe", access_level: "write" },
            { tool_id: "wellnessdb_day_range", access_level: "read" },
            { tool_id: "wellnessdb_day_summary", access_level: "read" },
            { tool_id: "wellnessdb_duplicate_recipe", access_level: "write" },
            { tool_id: "wellnessdb_get_recipe_detail", access_level: "read" },
            { tool_id: "wellnessdb_recent_meals", access_level: "read" },
            { tool_id: "wellnessdb_remove_recipe_ingredient", access_level: "write" },
            { tool_id: "wellnessdb_search_product", access_level: "read" },
            { tool_id: "wellnessdb_search_recipe", access_level: "read" },
            { tool_id: "wellnessdb_update_product", access_level: "write" },
            { tool_id: "wellnessdb_update_recipe", access_level: "write" },
            { tool_id: "wellnessdb_update_recipe_ingredient", access_level: "write" },
          ] : []);
        }
        // Replay the wellness migrations to verify INSERT OR IGNORE behavior.
        upgradedDb.exec("PRAGMA user_version = 76");
      } finally { upgraded.close(); }
    }
  });
});

describe("legacy wellness tool retirement (migration 78)", () => {
  const retired = ["atlas_sql", "recipe_list", "recipe_read", "recipe_write"];

  it.each([true, false])("removes retired tools on fresh databases with example roster=%s", (seedExampleRoster) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-retired-tools-"));
    tempDirs.push(dir);
    const storage = new TangoStorage(path.join(dir, "tango.sqlite"), { seedExampleRoster });
    try {
      const db = storage.getDatabase();
      for (const tool of retired) {
        expect(db.prepare("SELECT * FROM permissions WHERE tool_id = ?").all(tool)).toEqual([]);
        expect(db.prepare("SELECT * FROM governance_tools WHERE id = ?").all(tool)).toEqual([]);
      }
    } finally { storage.close(); }
  });

  it("removes existing grants for every principal and preserves wellness.db grants on upgrade and replay", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-retired-upgrade-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "tango.sqlite");
    const initial = new TangoStorage(dbPath);
    const db = initial.getDatabase();
    db.exec(`INSERT INTO principals (id, type, display_name) VALUES
      ('agent:retirement-test', 'agent', 'Retirement test'),
      ('worker:retirement-test', 'worker', 'Retirement worker')`);
    for (const tool of retired) {
      db.prepare("INSERT INTO governance_tools (id, domain, display_name, access_type) VALUES (?, 'wellness', ?, 'write')").run(tool, tool);
      for (const principal of ["agent:retirement-test", "worker:retirement-test"]) {
        db.prepare("INSERT INTO permissions (principal_id, tool_id, access_level, reason) VALUES (?, ?, 'write', 'upgrade fixture')").run(principal, tool);
      }
    }
    db.exec(`INSERT INTO permissions (principal_id, tool_id, access_level, reason)
      VALUES ('agent:retirement-test', 'wellnessdb_search_recipe', 'read', 'preserve');
      PRAGMA user_version = 77`);
    initial.close();
    for (let attempt = 0; attempt < 2; attempt++) {
      const upgraded = new TangoStorage(dbPath);
      try {
        const upgradedDb = upgraded.getDatabase();
        expect(upgradedDb.prepare("PRAGMA user_version").get()).toEqual({ user_version: 86 });
        for (const tool of retired) {
          expect(upgradedDb.prepare("SELECT * FROM permissions WHERE tool_id = ?").all(tool)).toEqual([]);
          expect(upgradedDb.prepare("SELECT * FROM governance_tools WHERE id = ?").all(tool)).toEqual([]);
        }
        expect(upgradedDb.prepare("SELECT tool_id FROM permissions WHERE principal_id = 'agent:retirement-test'").all())
          .toEqual([{ tool_id: "wellnessdb_search_recipe" }]);
        upgradedDb.exec("PRAGMA user_version = 77");
      } finally { upgraded.close(); }
    }
  });
});

describe("recipe admin governance (migration 79)", () => {
  const tools = [
    "wellnessdb_add_recipe_ingredient", "wellnessdb_update_recipe_ingredient",
    "wellnessdb_remove_recipe_ingredient", "wellnessdb_archive_recipe", "wellnessdb_duplicate_recipe",
  ];
  const principals = ["agent:malibu", "agent:malibu-ollama", "worker:recipe-librarian"];

  it.each([true, false])("registers writes and grants only existing principals, present=%s", (present) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-recipe-admin-governance-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "tango.sqlite");
    const initial = new TangoStorage(dbPath);
    const db = initial.getDatabase();
    // Fresh databases have the catalog but must remain ungranted by default.
    for (const tool of tools) {
      expect(db.prepare("SELECT domain, access_type FROM governance_tools WHERE id = ?").get(tool))
        .toMatchObject({ domain: "wellness-db", access_type: "write" });
      expect(db.prepare("SELECT * FROM permissions WHERE tool_id = ?").all(tool)).toEqual([]);
      db.prepare("DELETE FROM governance_tools WHERE id = ?").run(tool);
    }
    if (present) {
      for (const principal of principals) {
        db.prepare("INSERT INTO principals (id, type, display_name) VALUES (?, ?, ?)")
          .run(principal, principal.startsWith("worker:") ? "worker" : "agent", principal);
      }
    }
    db.exec("PRAGMA user_version = 78");
    initial.close();
    for (let attempt = 0; attempt < 2; attempt++) {
      const upgraded = new TangoStorage(dbPath);
      try {
        const upgradedDb = upgraded.getDatabase();
        expect(upgradedDb.prepare("PRAGMA user_version").get()).toEqual({ user_version: 86 });
        for (const tool of tools) {
          expect(upgradedDb.prepare("SELECT domain, access_type FROM governance_tools WHERE id = ?").get(tool))
            .toMatchObject({ domain: "wellness-db", access_type: "write" });
          for (const principal of principals) {
            expect(upgradedDb.prepare("SELECT access_level FROM permissions WHERE principal_id = ? AND tool_id = ?")
              .all(principal, tool)).toEqual(present ? [{ access_level: "write" }] : []);
          }
          expect(upgradedDb.prepare("SELECT principal_id FROM permissions WHERE tool_id = ? ORDER BY principal_id").all(tool))
            .toEqual(present ? principals.map((principal_id) => ({ principal_id })) : []);
        }
        upgradedDb.exec("PRAGMA user_version = 78");
      } finally { upgraded.close(); }
    }
  });
});

describe("Wispr Flow governance (migration 81)", () => {
  it.each([true, false])("adds the catalog row and grant on upgrade when the worker exists=%s", (present) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-wispr-upgrade-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "tango.sqlite");
    const initial = new TangoStorage(dbPath);
    const db = initial.getDatabase();
    db.exec("DELETE FROM permissions WHERE tool_id = 'wispr_flow'");
    db.exec("DELETE FROM governance_tools WHERE id = 'wispr_flow'");
    if (present) {
      db.exec(`INSERT OR IGNORE INTO principals (id, type, display_name) VALUES
        ('worker:personal-assistant', 'worker', 'Personal assistant')`);
    }
    db.exec("PRAGMA user_version = 80");
    initial.close();
    for (let attempt = 0; attempt < 2; attempt++) {
      const upgraded = new TangoStorage(dbPath);
      try {
        const upgradedDb = upgraded.getDatabase();
        expect(upgradedDb.prepare("SELECT domain, access_type FROM governance_tools WHERE id = 'wispr_flow'").get())
          .toMatchObject({ domain: "personal", access_type: "read" });
        expect(upgradedDb.prepare("SELECT principal_id, access_level FROM permissions WHERE tool_id = 'wispr_flow'").all())
          .toEqual(present ? [{ principal_id: "worker:personal-assistant", access_level: "read" }] : []);
        upgradedDb.exec("PRAGMA user_version = 80");
      } finally { upgraded.close(); }
    }
  });
});

describe("Bank transfer governance (migration 82)", () => {
  it.each([true, false])("adds the catalog row and a Foxtrot-only grant on upgrade when the worker exists=%s", (present) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-bank-upgrade-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "tango.sqlite");
    const initial = new TangoStorage(dbPath);
    const db = initial.getDatabase();
    db.exec("DELETE FROM permissions WHERE tool_id = 'bank_transfer'");
    db.exec("DELETE FROM governance_tools WHERE id = 'bank_transfer'");
    if (present) {
      db.exec(`INSERT OR IGNORE INTO principals (id, type, display_name) VALUES
        ('worker:foxtrot', 'worker', 'Foxtrot Runtime'),
        ('worker:foxtrot-ollama', 'worker', 'Foxtrot Ollama Runtime')`);
    }
    db.exec("PRAGMA user_version = 81");
    initial.close();
    for (let attempt = 0; attempt < 2; attempt++) {
      const upgraded = new TangoStorage(dbPath);
      try {
        const upgradedDb = upgraded.getDatabase();
        expect(upgradedDb.prepare("SELECT domain, access_type FROM governance_tools WHERE id = 'bank_transfer'").get())
          .toMatchObject({ domain: "personal", access_type: "write" });
        expect(upgradedDb.prepare("SELECT principal_id, access_level FROM permissions WHERE tool_id = 'bank_transfer'").all())
          .toEqual(present ? [{ principal_id: "worker:foxtrot", access_level: "write" }] : []);
        upgradedDb.exec("PRAGMA user_version = 81");
      } finally { upgraded.close(); }
    }
  });
});

describe("Day One governance (migration 83)", () => {
  it("adds the catalog rows on upgrade without granting anyone", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-dayone-upgrade-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "tango.sqlite");
    const initial = new TangoStorage(dbPath);
    const db = initial.getDatabase();
    db.exec("DELETE FROM governance_tools WHERE id IN ('dayone_read', 'dayone_write'); PRAGMA user_version = 82");
    initial.close();
    for (let attempt = 0; attempt < 2; attempt++) {
      const upgraded = new TangoStorage(dbPath);
      try {
        const upgradedDb = upgraded.getDatabase();
        expect(upgradedDb.prepare("PRAGMA user_version").get()).toEqual({ user_version: 86 });
        expect(upgradedDb.prepare("SELECT id, access_type FROM governance_tools WHERE id LIKE 'dayone_%' ORDER BY id").all())
          .toEqual([{ id: "dayone_read", access_type: "read" }, { id: "dayone_write", access_type: "write" }]);
        expect(upgradedDb.prepare("SELECT * FROM permissions WHERE tool_id LIKE 'dayone_%'").all()).toEqual([]);
        upgradedDb.exec("PRAGMA user_version = 82");
      } finally { upgraded.close(); }
    }
  });
});
