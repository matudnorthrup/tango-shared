import { describe, expect, it, vi } from "vitest";
import {
  buildCollaborationToolPresentation,
  createCollaborationTools,
} from "../src/collaboration-agent-tools.js";
import type { V2AgentConfig } from "@tango/core";

describe("collaboration-agent-tools", () => {
  it("constrains the listed tool to the caller's configured route pairs", () => {
    const [tool] = createCollaborationTools();
    const configs = new Map<string, V2AgentConfig>([
      [
        "foxtrot",
        {
          id: "foxtrot",
          enabled: true,
          responsibilities: [
            {
              id: "finance_support",
              description: "Coordinate bounded Kilo spending support.",
              collaboration: {
                canRequest: [
                  { agent: "kilo", purposes: ["kilo-spending-support"] },
                ],
              },
            },
          ],
        } as V2AgentConfig,
      ],
    ]);

    const presentation = buildCollaborationToolPresentation(tool!, "foxtrot", configs);
    const schema = presentation.inputSchema as Record<string, unknown>;
    const properties = schema.properties as Record<string, Record<string, unknown>>;

    expect(presentation.description).toContain("target_agent_id=kilo; purpose=kilo-spending-support");
    expect(properties.target_agent_id?.enum).toEqual(["kilo"]);
    expect(properties.purpose?.enum).toEqual(["kilo-spending-support"]);
    expect(schema.allOf).toEqual(expect.arrayContaining([
      expect.objectContaining({
        oneOf: [
          expect.objectContaining({
            properties: {
              target_agent_id: { const: "kilo" },
              purpose: { const: "kilo-spending-support" },
            },
          }),
        ],
      }),
    ]));
  });

  it("posts bounded collaboration requests to the bridge with the governed requester id", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({
      collaborationId: "collab-1",
      status: "completed",
      answer: "Done",
    }), { status: 200 }));
    const [tool] = createCollaborationTools({
      bridgeUrl: "http://127.0.0.1:9200/collaboration/request",
      bridgeToken: "secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await tool!.handler({
      _requester_agent_id: "ops",
      requester_agent_id: "spoofed",
      target_agent_id: "research",
      purpose: "source-check",
      objective: "Check a source.",
      context_summary: "A draft has a claim.",
      visibility: "summary",
      user_surface: { kind: "discord", channel_id: "spoofed-channel" },
      _conversation_key: "conversation-1",
      _turn_id: "turn-1",
      _message_id: "message-1",
      _channel_id: "channel-1",
      _thread_id: "thread-1",
    });

    expect(result).toEqual({
      collaborationId: "collab-1",
      status: "completed",
      answer: "Done",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:9200/collaboration/request");
    expect((init as RequestInit).headers).toMatchObject({
      "Content-Type": "application/json",
      "X-Tango-Collaboration-Token": "secret",
    });
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      requester_agent_id: "ops",
      target_agent_id: "research",
      purpose: "source-check",
      objective: "Check a source.",
      initiator_kind: "agent",
      user_surface: {
        kind: "discord",
        channel_id: "channel-1",
        thread_id: "thread-1",
        message_id: "message-1",
        turn_id: "turn-1",
        conversation_key: "conversation-1",
      },
    });
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).not.toHaveProperty("_requester_agent_id");
    expect(body).not.toHaveProperty("_channel_id");
    expect(body.user_surface.channel_id).not.toBe("spoofed-channel");
  });

  it("fails before bridge calls when requester identity is unavailable", async () => {
    const fetchImpl = vi.fn();
    const [tool] = createCollaborationTools({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await tool!.handler({
      target_agent_id: "research",
      purpose: "source-check",
      objective: "Check a source.",
    });

    expect(result).toMatchObject({
      status: "failed",
      error: "requester_agent_id unavailable; collaboration tool must run inside a governed agent runtime",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not accept a caller-supplied requester identity", async () => {
    const fetchImpl = vi.fn();
    const [tool] = createCollaborationTools({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await tool!.handler({
      requester_agent_id: "spoofed",
      target_agent_id: "research",
      purpose: "source-check",
      objective: "Check a source.",
    });

    expect(result).toMatchObject({
      status: "failed",
      error: "requester_agent_id unavailable; collaboration tool must run inside a governed agent runtime",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns actionable permitted routes when the bridge denies a request", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      status: "denied",
      error: "requester_not_allowed",
      availableRoutes: [{ targetAgentId: "research", purposes: ["source-check"] }],
    }), { status: 403 }));
    const [tool] = createCollaborationTools({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await tool!.handler({
      _requester_agent_id: "ops",
      target_agent_id: "research",
      purpose: "source-check",
      objective: "Check a source.",
    });

    expect(result).toMatchObject({
      status: "denied",
      error: "Collaboration denied: requester_not_allowed. Use one of the available_routes and retry.",
      available_routes: [{ targetAgentId: "research", purposes: ["source-check"] }],
      detail: {
        error: "requester_not_allowed",
      },
    });
  });
});
