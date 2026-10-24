/**
 * Linear Agent Tools — Universal GraphQL API tool for project management.
 *
 * Tools:
 *   - linear: Raw GraphQL passthrough to Linear API
 */

import type { AgentTool } from "@tango/core";
import { getSecret } from "./op-secret.js";

let cachedApiKey: string | null = null;
async function getApiKey(): Promise<string> {
  if (!cachedApiKey) {
    const envKey = process.env.LINEAR_API_KEY?.trim();
    const opKey =
      envKey
      || await getSecret("Watson", "Linear Example-HQ Tango API Key")
      || await getSecret("Watson", "Linear API key owner-watson");
    if (!opKey) {
      throw new Error(
        "Linear API key not found. Set LINEAR_API_KEY or add 1Password item " +
        "'Linear Example-HQ Tango API Key' in the Watson vault.",
      );
    }
    cachedApiKey = opKey;
  }
  return cachedApiKey;
}

export function createLinearTools(): AgentTool[] {
  return [
    {
      name: "linear",
      description: [
        "Linear GraphQL API for Tango project management in the Example HQ workspace — issues, projects, cycles, documents, comments.",
        "",
        "Endpoint: https://api.linear.app/graphql (POST)",
        "",
        "Key entities: Issue (id, identifier, title, description, state, assignee, project, labels, priority 0-4, dueDate),",
        "Project (id, name, state, issues), Team (id, name, key), Cycle, Document (id, title, content), Comment.",
        "",
        "Pagination: Relay-style — use first/after with nodes[] and pageInfo { hasNextPage endCursor }.",
        "",
        "Filtering: comparators (eq, neq, contains, in, lt, gt), relative dates (\"P2W\" = next 2 weeks, \"-P2W\" = past 2 weeks),",
        "logical OR: filter: { or: [...] }. State types: triage, backlog, unstarted, started, completed, canceled.",
        "",
        "Priority: 0=none, 1=urgent, 2=high, 3=medium, 4=low.",
        "",
        "Issue identifiers (e.g. \"ENG-123\") work directly in issue(id:) queries.",
        "Archived resources hidden by default; use includeArchived: true to include.",
        "",
        "Rate limits: 5,000 requests/hour, 250K complexity points/hour, 10K complexity per query.",
        "Keep first values small (10-25) when nesting connections.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "GraphQL query or mutation string",
          },
          variables: {
            type: "object",
            description: "Optional GraphQL variables",
          },
        },
        required: ["query"],
      },
      handler: async (input) => {
        const query = String(input.query);
        const variables = input.variables as Record<string, unknown> | undefined;

        const apiKey = await getApiKey();

        const response = await fetch("https://api.linear.app/graphql", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: apiKey,
          },
          body: JSON.stringify({ query, variables: variables ?? undefined }),
          signal: AbortSignal.timeout(30_000),
        });

        const text = await response.text();

        if (!response.ok) {
          return { error: `HTTP ${response.status}: ${text}` };
        }

        try {
          const json = JSON.parse(text);
          const rateLimitRemaining = response.headers.get("x-ratelimit-requests-remaining");
          if (rateLimitRemaining) {
            json._rateLimitRemaining = parseInt(rateLimitRemaining, 10);
          }
          return json;
        } catch {
          return { result: text };
        }
      },
    },
  ];
}
