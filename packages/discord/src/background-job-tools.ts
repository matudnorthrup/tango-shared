import type { AgentTool } from "@tango/core";

const DEFAULT_BACKGROUND_JOB_BRIDGE_URL = "http://127.0.0.1:9200/background-jobs";

export interface BackgroundJobToolOptions {
  bridgeUrl?: string;
  bridgeToken?: string;
  fetchImpl?: typeof fetch;
}

/**
 * `background_job` runs in the MCP server process, but jobs are owned by the
 * bot process (it must wake the agent in Discord when one ends), so the handler
 * forwards to the bot's local bridge — the same pattern as
 * collaborate_with_agent. The server injects the trusted `_requester_agent_id`,
 * `_channel_id`, and `_thread_id` fields; they are forwarded as-is.
 */
export function createBackgroundJobTools(options: BackgroundJobToolOptions = {}): AgentTool[] {
  const fetchFn = options.fetchImpl ?? fetch;
  const bridgeUrl =
    options.bridgeUrl
    ?? process.env.TANGO_BACKGROUND_JOB_BRIDGE_URL
    ?? DEFAULT_BACKGROUND_JOB_BRIDGE_URL;
  const bridgeToken =
    options.bridgeToken
    ?? process.env.TANGO_COLLABORATION_BRIDGE_TOKEN;

  return [
    {
      name: "background_job",
      description: [
        "Run a long shell batch (minutes to hours) outside your turn, so the turn time limit cannot kill it.",
        "action=start runs `command` with zsh in its own job directory, capturing stdout+stderr to output.log.",
        "When the job exits you get a NEW turn in this same conversation saying so; read the results then. After starting a job, tell the user what is running and end your turn — do not poll.",
        "Write scripts so they save results to files as they go. Use absolute paths.",
        "action=status (job_id) shows progress and the output tail; action=list shows your recent jobs; action=cancel (job_id) stops one.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["start", "status", "list", "cancel"],
          },
          label: {
            type: "string",
            description: "Short human name for the job, shown in the completion notice (start).",
          },
          command: {
            type: "string",
            description: "Shell script to run with zsh (start). For anything long, write a script file first and run it here.",
          },
          timeout_seconds: {
            type: "number",
            description: "Hard limit for the job (start). Default 3600, min 60, max 14400.",
          },
          job_id: {
            type: "string",
            description: "Job id for status or cancel.",
          },
        },
        required: ["action"],
      },
      handler: async (input) => {
        const response = await fetchFn(bridgeUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(bridgeToken ? { "X-Tango-Collaboration-Token": bridgeToken } : {}),
          },
          body: JSON.stringify(input),
        });
        const text = await response.text();
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          body = { error: text || `bridge returned HTTP ${response.status}` };
        }
        if (!response.ok) {
          const message = body && typeof body === "object" && "error" in body
            ? String((body as { error: unknown }).error)
            : `bridge returned HTTP ${response.status}`;
          return { error: message };
        }
        return body;
      },
    },
  ];
}
