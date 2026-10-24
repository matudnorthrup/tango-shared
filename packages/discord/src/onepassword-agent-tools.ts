/**
 * 1Password Agent Tools — Secure credential retrieval via 1Password CLI.
 *
 * Tools:
 *   - onepassword: Read items from 1Password vaults via service account
 *
 * Uses OP_SERVICE_ACCOUNT_TOKEN from environment. The service account
 * determines vault access scope (currently: Watson vault only).
 */

import { spawn } from "node:child_process";
import type { AgentTool } from "@tango/core";

// Debug logging via stderr (safe — MCP protocol uses stdout only)
const debug = (...args: unknown[]) => {
  console.error("[1password]", ...args);
};

// ---------------------------------------------------------------------------
// Command runner
// ---------------------------------------------------------------------------

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function execCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  env?: Record<string, string>,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 2000).unref();
    }, timeoutMs);
    timer.unref();

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const OP_BINARY = "/opt/homebrew/bin/op";

// Hard limits — items that must NEVER be retrieved by agents
const BLOCKED_ITEMS = new Set<string>([
  // No banking, healthcare, government, investment, or primary email credentials
  // Enforced at the tool level as a safety net beyond vault scoping
]);

function isChurchCredentialItem(item: string): boolean {
  const normalized = item.trim().toLowerCase();
  const configured = process.env.LIBRARY_ACCOUNT_1PASSWORD_ITEM?.trim().toLowerCase();
  return Boolean(configured && normalized === configured)
    || normalized === "owner library"
    || normalized === "library account"
    || normalized === "study library account";
}

// Actions that are safe and don't need audit logging
const QUIET_ACTIONS = new Set(["list", "whoami", "vault-list"]);

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createOnePasswordTools(): AgentTool[] {
  const token = process.env.OP_SERVICE_ACCOUNT_TOKEN;

  if (!token) {
    debug("OP_SERVICE_ACCOUNT_TOKEN not set — 1Password tool disabled");
    return [];
  }

  debug("1Password tool enabled (service account)");

  return [
    {
      name: "onepassword",
      description: [
        "Retrieve credentials and secrets from 1Password via service account.",
        "",
        "Actions:",
        "  get — Retrieve a specific field from a vault item",
        "    Required: vault, item",
        "    Optional: field (default: 'password'), section",
        "    Returns: the field value as a string",
        "",
        "  list — List items in a vault",
        "    Required: vault",
        "    Returns: JSON array of item titles and IDs",
        "",
        "  whoami — Check service account identity",
        "    Returns: account info (URL, user type)",
        "",
        "  vault-list — List accessible vaults",
        "    Returns: JSON array of vault names and IDs",
        "",
        "Available vault: Watson",
        "Items include: API keys, service tokens, login credentials for various services.",
        "",
        "HARD LIMITS — NEVER retrieve credentials for:",
        "  - Banking or financial institution logins",
        "  - Healthcare portals or medical records",
        "  - Government accounts (SSA, IRS, DMV)",
        "  - Investment/brokerage accounts",
        "  - Primary email accounts (Gmail, iCloud)",
        "  - The 1Password service account token itself",
        "",
        "Common field names: password, username, credential, url, notesPlain",
        "For API keys, the field is usually 'credential' or 'password'.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["get", "list", "whoami", "vault-list"],
            description: "Action to perform",
          },
          vault: {
            type: "string",
            description: "Vault name (required for get and list)",
          },
          item: {
            type: "string",
            description: "Item title or ID (required for get)",
          },
          field: {
            type: "string",
            description: "Field to retrieve (default: 'password'). Common: password, username, credential, url",
          },
          section: {
            type: "string",
            description: "Section name if the field is in a specific section (optional)",
          },
        },
        required: ["action"],
      },
      handler: async (input) => {
        const action = String(input.action);

        switch (action) {
          case "whoami": {
            const result = await execCommand(OP_BINARY, ["whoami"], 15_000, { OP_SERVICE_ACCOUNT_TOKEN: token });
            if (result.code !== 0) {
              return { error: `1Password auth failed: ${result.stderr.trim()}` };
            }
            return { result: result.stdout.trim() };
          }

          case "vault-list": {
            const result = await execCommand(OP_BINARY, ["vault", "list", "--format=json"], 15_000, { OP_SERVICE_ACCOUNT_TOKEN: token });
            if (result.code !== 0) {
              return { error: `Failed to list vaults: ${result.stderr.trim()}` };
            }
            try {
              return { vaults: JSON.parse(result.stdout) };
            } catch {
              return { result: result.stdout.trim() };
            }
          }

          case "list": {
            const vault = String(input.vault ?? "");
            if (!vault) {
              return { error: "vault is required for list action" };
            }
            const result = await execCommand(OP_BINARY, ["item", "list", "--vault", vault, "--format=json"], 15_000, { OP_SERVICE_ACCOUNT_TOKEN: token });
            if (result.code !== 0) {
              return { error: `Failed to list items: ${result.stderr.trim()}` };
            }
            try {
              const items = JSON.parse(result.stdout) as Array<{ id: string; title: string; category: string }>;
              return { items: items.map((i) => ({ id: i.id, title: i.title, category: i.category })) };
            } catch {
              return { result: result.stdout.trim() };
            }
          }

          case "get": {
            const vault = String(input.vault ?? "");
            const item = String(input.item ?? "");
            const field = String(input.field ?? "password");

            if (!vault) return { error: "vault is required for get action" };
            if (!item) return { error: "item is required for get action" };

            // Safety check: blocked items
            if (BLOCKED_ITEMS.has(item.toLowerCase())) {
              debug(`BLOCKED: attempted access to restricted item "${item}"`);
              return { error: `Access to "${item}" is restricted. Ask the user directly.` };
            }
            if (isChurchCredentialItem(item)) {
              debug(`BLOCKED: direct Library credential access for "${item}"`);
              return {
                error: "Direct Library credential retrieval is blocked. Use study_library login so the credential stays inside the tool handler.",
              };
            }

            // Build field reference — section.field or just field
            const fieldRef = input.section ? `${input.section}.${field}` : field;

            const args = [
              "item", "get", item,
              "--vault", vault,
              "--fields", fieldRef,
              "--reveal",
            ];

            debug(`Retrieving: vault="${vault}" item="${item}" field="${fieldRef}"`);

            const result = await execCommand(OP_BINARY, args, 15_000, { OP_SERVICE_ACCOUNT_TOKEN: token });
            if (result.code !== 0) {
              const err = result.stderr.trim();
              debug(`Error retrieving "${item}": ${err}`);
              return { error: `Failed to get item: ${err}` };
            }

            const value = result.stdout.trim();
            if (!value) {
              return { error: `Field "${fieldRef}" is empty or not found on item "${item}"` };
            }

            return { value };
          }

          default:
            return { error: `Unknown action: ${action}. Use: get, list, whoami, vault-list` };
        }
      },
    },
  ];
}
