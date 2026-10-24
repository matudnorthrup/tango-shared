import { describe, expect, it } from "vitest";
import type { AgentRuntimeConfig } from "../src/agent-runtime.js";
import { selectMcpServersForTurn } from "../src/mcp-mounting.js";

function createConfig(): AgentRuntimeConfig {
  return {
    agentId: "watson",
    systemPrompt: "You are Watson.",
    mcpServers: [
      {
        name: "memory",
        command: "node",
        args: ["memory.js"],
      },
    ],
    availableMcpServers: [
      {
        name: "attachments",
        command: "node",
        args: ["mcp-proxy.js", "attachments"],
      },
      {
        name: "send-image",
        command: "node",
        args: ["mcp-proxy.js", "send-image"],
      },
      {
        name: "wispr-flow",
        command: "npx",
        args: ["-y", "mcp-remote@0.8.5", "https://api.wisprflow.ai/connect/mcp"],
      },
    ],
    runtimePreferences: {
      model: "claude-sonnet-4-6",
    },
  };
}

describe("selectMcpServersForTurn", () => {
  it("mounts configured Things tools for task-list requests", () => {
    const config = createConfig();
    config.availableMcpServers!.push({ name: "things", command: "node", args: ["mcp-proxy.js", "things"] });
    const result = selectMcpServersForTurn(config, { message: "Check my to-do list" });
    expect(result.selection.activatedServerNames).toContain("things");
  });
  it("keeps only default MCP servers when no conditional capability is needed", () => {
    const result = selectMcpServersForTurn(createConfig(), {
      message: "Morning Watson",
    });

    expect(result.config.mcpServers.map((server) => server.name)).toEqual(["memory"]);
    expect(result.selection).toMatchObject({
      defaultServerNames: ["memory"],
      availableServerNames: ["attachments", "send-image", "wispr-flow"],
      mountedServerNames: ["memory"],
      activatedServerNames: [],
    });
  });

  it("promotes attachments when the turn references an uploaded file", () => {
    const result = selectMcpServersForTurn(createConfig(), {
      message: "Can you read the PDF I uploaded?",
    });

    expect(result.config.mcpServers.map((server) => server.name)).toEqual([
      "memory",
      "attachments",
    ]);
    expect(result.selection.triggerReasons.attachments).toContain("turn-keyword");
  });

  it("promotes send-image when the turn asks to show a screenshot", () => {
    const result = selectMcpServersForTurn(createConfig(), {
      message: "Please send a screenshot of the map.",
    });

    expect(result.config.mcpServers.map((server) => server.name)).toEqual([
      "memory",
      "send-image",
    ]);
    expect(result.selection.triggerReasons["send-image"]).toContain("turn-keyword");
  });

  it("promotes desk-mail for other agents, other threads, starting a thread, and mail turns", () => {
    const withDeskMail = () => {
      const config = createConfig();
      config.availableMcpServers = [...(config.availableMcpServers ?? []), { name: "desk-mail", command: "node", args: ["mcp-proxy.js", "desk-mail"] }];
      return config;
    };
    const mounted = (message: string) => selectMcpServersForTurn(withDeskMail(), { message }).config.mcpServers.map((server) => server.name);
    expect(mounted("Ask the board game thread which port it uses")).toContain("desk-mail");
    expect(mounted("Start a new thread to build the card back art pipeline")).toContain("desk-mail");
    expect(mounted("What's running on my coding threads?")).toContain("desk-mail");
    expect(mounted("✉️ Mail from “tango · Overview map” [t3:a] · m-1a2b3c4d\n\nport?")).toContain("desk-mail");
    expect(mounted("What's for dinner?")).not.toContain("desk-mail");
  });

  it("promotes attachments when inline images are present", () => {
    const result = selectMcpServersForTurn(createConfig(), {
      message: "What do you see?",
      sendOptions: {
        images: [
          {
            mediaType: "image/png",
            dataBase64: Buffer.from("fake").toString("base64"),
          },
        ],
      },
    });

    expect(result.config.mcpServers.map((server) => server.name)).toEqual([
      "memory",
      "attachments",
    ]);
    expect(result.selection.triggerReasons.attachments).toContain("images-present");
  });

  it.each([
    "Add a Day One entry about today's hike",
    "What did I write in my journal last week?",
    "Show me my on this day entries",
  ])("promotes dayone for journal turn %s", (message) => {
    const config = createConfig();
    config.availableMcpServers!.push({
      name: "dayone",
      command: "node",
      args: ["mcp-proxy.js", "dayone"],
    });
    const result = selectMcpServersForTurn(config, { message });

    expect(result.selection.activatedServerNames).toContain("dayone");
    expect(result.selection.triggerReasons.dayone).toContain("turn-keyword");
  });

  it("promotes wispr-flow when the turn asks about a recorded meeting", () => {
    const result = selectMcpServersForTurn(createConfig(), {
      message: "What did we decide in yesterday's standup?",
    });

    expect(result.config.mcpServers.map((server) => server.name)).toContain("wispr-flow");
    expect(result.selection.triggerReasons["wispr-flow"]).toContain("turn-keyword");
  });

  it.each([
    "What did I commit to in the 1:1 with Riley?",
    "What did we agree on in the retro?",
    "Summarize the meeting from this morning",
    "What were the decisions from yesterday's meeting?",
    "Any agreements out of the retro?",
    "What are the attendee email addresses from yesterday's standup?",
    "Who attended the retro?",
    "Who did I meet with yesterday?",
    "Find my meeting with Alice",
    "What's this? https://meet.google.com/abc-defg-hij",
    "Resolve https://us02web.zoom.us/j/123456789",
  ])("promotes wispr-flow for meeting-recall turn %s", (message) => {
    const result = selectMcpServersForTurn(createConfig(), { message });

    expect(result.config.mcpServers.map((server) => server.name)).toContain("wispr-flow");
  });

  it("promotes wispr-flow for a pasted shared-notes link", () => {
    const result = selectMcpServersForTurn(createConfig(), {
      message: "Can you read https://notes.wisprflow.ai/shared/abc123 for me?",
    });

    expect(result.config.mcpServers.map((server) => server.name)).toContain("wispr-flow");
  });

  it("leaves wispr-flow unmounted on an unrelated turn", () => {
    const result = selectMcpServersForTurn(createConfig(), {
      message: "Morning Watson",
    });

    expect(result.config.mcpServers.map((server) => server.name)).not.toContain("wispr-flow");
  });
});
