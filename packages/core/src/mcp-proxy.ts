#!/usr/bin/env node
/**
 * MCP Proxy — Thin stdio↔HTTP bridge for persistent MCP server.
 *
 * The Claude CLI spawns this script as an MCP server (via stdio transport).
 * Instead of loading tools and initializing governance (which takes 60-90s),
 * this proxy immediately connects to an already-running HTTP MCP server
 * and forwards JSON-RPC messages bidirectionally.
 *
 * Startup time: <100ms (only node:* builtins, zero external deps).
 *
 * Env vars:
 *   MCP_SERVER_PORT — Port of the persistent HTTP MCP server (default: 9100)
 *   WORKER_ID       — Worker identity for governance filtering
 *   TANGO_DB_PATH   — Passed through but unused (governance is on the server)
 */

import { createInterface } from "node:readline";
import { request as httpRequest } from "node:http";
import { writeFileSync } from "node:fs";

const PORT = parseInt(process.env.MCP_SERVER_PORT || "9100", 10);
const WORKER_ID = process.env.WORKER_ID || "";
const READ_ONLY_STEP = process.env.READ_ONLY_STEP === "1";
const ALLOWED_TOOL_IDS = process.env.ALLOWED_TOOL_IDS;
const KEEPALIVE_FILE = process.env.MCP_KEEPALIVE_FILE || "";
const CONVERSATION_KEY = process.env.TANGO_CONVERSATION_KEY || "";
const TURN_ID = process.env.TANGO_TURN_ID || "";
const MESSAGE_ID = process.env.TANGO_MESSAGE_ID || "";
const CHANNEL_ID = process.env.TANGO_DISCORD_CHANNEL_ID || "";
const THREAD_ID = process.env.TANGO_DISCORD_THREAD_ID || "";

const debug = (...args: unknown[]) => {
  process.stderr.write(`[mcp-proxy] ${args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")}\n`);
};

debug(
  `Starting proxy → http://127.0.0.1:${PORT}/mcp (` +
  `worker=${WORKER_ID || "none"} readOnly=${READ_ONLY_STEP ? "yes" : "no"} ` +
  `allowedTools=${ALLOWED_TOOL_IDS ?? "all"})`,
);

/**
 * POST a JSON-RPC message to the persistent MCP server and return the response.
 * Returns null for notifications (204 No Content).
 */
function postOnce(body: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port: PORT,
        path: "/mcp",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          ...(WORKER_ID ? { "X-Worker-ID": WORKER_ID } : {}),
          ...(READ_ONLY_STEP ? { "X-Read-Only-Step": "1" } : {}),
          ...(ALLOWED_TOOL_IDS !== undefined ? { "X-Allowed-Tool-Ids": ALLOWED_TOOL_IDS } : {}),
          ...(CONVERSATION_KEY ? { "X-Tango-Conversation-Key": CONVERSATION_KEY } : {}),
          ...(TURN_ID ? { "X-Tango-Turn-Id": TURN_ID } : {}),
          ...(MESSAGE_ID ? { "X-Tango-Message-Id": MESSAGE_ID } : {}),
          ...(CHANNEL_ID ? { "X-Tango-Channel-Id": CHANNEL_ID } : {}),
          ...(THREAD_ID ? { "X-Tango-Thread-Id": THREAD_ID } : {}),
        },
      },
      (res) => {
        if (res.statusCode === 204) {
          resolve(null);
          return;
        }
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("error", reject);
        res.on("aborted", () => reject(Object.assign(new Error("Connection reset"), { code: "ECONNRESET" })));
        res.on("end", () => {
          resolve(data || null);
        });
      },
    );

    req.on("error", (err) => {
      debug(`HTTP error: ${err.message}`);
      reject(err);
    });

    req.end(body);
  });
}

// Reconnect through bot restarts. Only connection failures are replayed.
async function postToServer(body: string): Promise<string | null> {
  const deadline = Date.now() + 90_000;
  let delay = 250;
  while (true) {
    try { return await postOnce(body); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Only a refused connection is safe to retry: the call never reached the server. A reset may come after
      // the server ran the tool, and the persistent server has no request dedup, so retrying could run a write twice.
      if (code !== "ECONNREFUSED" || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(delay, deadline - Date.now())));
      delay = Math.min(delay * 2, 5_000);
    }
  }
}

// Track pending requests so we don't exit before responses are sent
let pendingRequests = 0;
let stdinClosed = false;

function maybeExit() {
  if (stdinClosed && pendingRequests === 0) {
    debug("All requests complete, exiting");
    process.exit(0);
  }
}

// Read newline-delimited JSON-RPC messages from stdin (MCP stdio protocol)
const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
  if (!line.trim()) return;

  // Log each message to stderr and conditionally touch the keepalive file.
  // The CLI swallows MCP server stderr, so the watchdog can't see our
  // activity via stderr. The keepalive file is monitored by the caller
  // as an alternative activity signal.
  //
  // Only touch keepalive on tools/call — NOT on initialize or tools/list.
  // The MCP setup handshake always fires immediately, but the worker hasn't
  // started real work yet. The LLM may think for minutes before its first
  // tool call. If we signal activity during setup, the watchdog switches to
  // a short inactivity timeout and kills the worker while it's still thinking.
  let isToolCall = false;
  try {
    const parsed = JSON.parse(line) as { method?: string; id?: unknown };
    debug(`→ ${parsed.method ?? "response"}${parsed.id !== undefined ? ` (id=${parsed.id})` : ""}`);
    isToolCall = parsed.method === "tools/call";
  } catch {
    debug("→ (unparseable message)");
  }
  if (KEEPALIVE_FILE && isToolCall) {
    try { writeFileSync(KEEPALIVE_FILE, String(Date.now())); } catch { /* ignore */ }
  }

  pendingRequests++;
  postToServer(line)
    .then((response) => {
      if (response) {
        // Write response to stdout for the CLI (must end with newline)
        const trimmed = response.trim();
        process.stdout.write(trimmed + "\n");
        debug(`← response (${trimmed.length} bytes)`);
        if (KEEPALIVE_FILE) {
          try { writeFileSync(KEEPALIVE_FILE, String(Date.now())); } catch { /* ignore */ }
        }
      }
    })
    .catch((err) => {
      // If the server is unreachable, send a JSON-RPC error back to the CLI
      try {
        const msg = JSON.parse(line) as { id?: string | number };
        if ("id" in msg && msg.id !== undefined) {
          const errorResponse = JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: {
              code: -32000,
              message: `MCP proxy: server unreachable at port ${PORT}: ${err.message}`,
            },
          });
          process.stdout.write(errorResponse + "\n");
        }
      } catch {
        // Can't even parse the original message, nothing we can do
        debug("Failed to parse message for error response");
      }
    })
    .finally(() => {
      pendingRequests--;
      maybeExit();
    });
});

rl.on("close", () => {
  debug("stdin closed");
  stdinClosed = true;
  maybeExit();
});

// Keep process alive while stdin is open
process.stdin.resume();
