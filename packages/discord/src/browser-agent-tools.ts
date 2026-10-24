/**
 * Browser Agent Tools — Universal browser automation tool for Tango agents.
 *
 * Provides a single `browser` tool that wraps the native Playwright-based
 * BrowserManager. Agents use this for any web interaction: shopping, receipt
 * lookup, transaction categorization, form filling, etc.
 *
 * Requires Chrome/Brave running with --remote-debugging-port (for CDP connection).
 */

import type { AgentTool } from "@tango/core";
import { getBrowserManager } from "./browser-manager.js";
import { ensureSiteSession, siteScopeForUrl } from "./site-session.js";

export function createBrowserTools(): AgentTool[] {
  return [
    {
      name: "browser",
      description: [
        "Universal browser automation — navigate websites, read page content, and interact with elements.",
        "",
        "## Setup",
        "Use 'launch' to start Brave with remote debugging (preferred).",
        "Or 'connect' if Brave is already running with --remote-debugging-port.",
        "",
        "## Actions",
        "",
        "### Connection",
        "  launch — Start Brave with remote debugging and connect to it",
        "    port: Debugging port (default 9223). If Brave is already on that port, connects to it.",
        "",
        "  connect — Connect to an already-running browser via CDP",
        "    cdp_url (required): e.g. 'http://127.0.0.1:9223'",
        "",
        "  status — Check if browser is connected, get current page info",
        "",
        "  close — Disconnect from browser (Chrome stays open)",
        "",
        "### Navigation",
        "  open — Navigate to a URL",
        "    url (required): Full URL to navigate to",
        "",
        "### Page Reading",
        "  snapshot — Get page content with numbered refs for interactive elements",
        "    interactive: boolean — If true, only show interactive elements (compact)",
        "    Returns text with [N] refs for each button, link, input, etc.",
        "",
        "  screenshot — Take a screenshot, returns file path",
        "    full_page: boolean — Capture full page vs viewport only",
        "    ref: number — Capture a specific interactive element from the latest snapshot",
        "    selector: string — Capture the first element matching a Playwright locator/selector",
        "",
        "### Interaction (use ref numbers from snapshot)",
        "  click — Click element by ref number",
        "    ref (required): number from snapshot",
        "",
        "  fill — Fill an input field (clears existing value first)",
        "    ref (required): number from snapshot",
        "    value (required): text to enter",
        "",
        "  upload — Upload one or more files into a file input",
        "    ref (required): number from snapshot",
        "    files (required): string[] absolute file paths",
        "",
        "  type — Type text character-by-character (for autocomplete/search inputs)",
        "    ref (required): number from snapshot",
        "    value (required): text to type",
        "",
        "  press — Press a keyboard key",
        "    key (required): Key name (Enter, Tab, Escape, ArrowDown, etc.)",
        "",
        "  select — Select option from a dropdown",
        "    ref (required): number from snapshot",
        "    values (required): string[] of option values to select",
        "",
        "  scroll — Scroll the page",
        "    direction (required): 'up' or 'down'",
        "    pixels: number (default 600)",
        "",
        "  wait — Wait for a condition",
        "    text: Wait until this text appears on page",
        "    selector: Wait for CSS selector to appear",
        "    timeout: Wait N milliseconds (default 10000)",
        "",
        "  eval — Execute JavaScript in page context",
        "    script (required): JavaScript code string",
        "",
        "## Workflow",
        "  1. launch (or connect with cdp_url)",
        "  2. open a URL",
        "  3. snapshot to see the page and get refs",
        "  4. click/fill/type/select using refs",
        "  5. Re-snapshot after any navigation or action that changes the page",
        "",
        "## Important",
        "  - Refs are NOT stable across navigations — always re-snapshot after open/click",
        "  - For sites with bot detection (Walmart), use launch to start a real browser",
        "  - For login-required sites, log in manually in Chrome first",
        "  - Sites with a configured browser-session descriptor are the exception: 'open' restores their",
        "    login automatically from 1Password. Never type those passwords through fill/type.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "launch",
              "connect",
              "status",
              "close",
              "open",
              "snapshot",
              "screenshot",
              "click",
              "fill",
              "upload",
              "type",
              "press",
              "select",
              "scroll",
              "wait",
              "eval",
            ],
            description: "Browser action to perform",
          },
          port: {
            type: "number",
            description: "For launch: debugging port (default 9223)",
          },
          cdp_url: {
            type: "string",
            description: "For connect: CDP URL (e.g. http://127.0.0.1:9223). Rarely needed — prefer 'launch'.",
          },
          url: {
            type: "string",
            description: "For open: URL to navigate to",
          },
          ref: {
            type: "number",
            description: "For click/fill/type/select: element ref from snapshot",
          },
          value: {
            type: "string",
            description: "For fill/type: text value to enter",
          },
          files: {
            type: "array",
            items: { type: "string" },
            description: "For upload: absolute file paths to upload",
          },
          key: {
            type: "string",
            description: "For press: key name (Enter, Tab, Escape, etc.)",
          },
          values: {
            type: "array",
            items: { type: "string" },
            description: "For select: option values to select",
          },
          direction: {
            type: "string",
            enum: ["up", "down"],
            description: "For scroll: direction",
          },
          pixels: {
            type: "number",
            description: "For scroll: distance in pixels (default 600)",
          },
          text: {
            type: "string",
            description: "For wait: text to wait for on page",
          },
          selector: {
            type: "string",
            description: "For wait or screenshot: selector / Playwright locator to target",
          },
          timeout: {
            type: "number",
            description: "For wait: timeout in milliseconds (default 10000)",
          },
          interactive: {
            type: "boolean",
            description: "For snapshot: only show interactive elements",
          },
          full_page: {
            type: "boolean",
            description: "For screenshot: capture full page",
          },
          script: {
            type: "string",
            description: "For eval: JavaScript to execute in page context",
          },
        },
        required: ["action"],
      },
      handler: async (input) => {
        const bm = getBrowserManager();
        const action = String(input.action);
        const ensureConnectedForPageAction = async (): Promise<void> => {
          const status = await bm.status();
          if (status.connected) {
            return;
          }
          await bm.launch(9223);
        };

        switch (action) {
          case "launch": {
            const port = typeof input.port === "number" ? input.port as number : 9223;
            const msg = await bm.launch(port);
            return { result: msg };
          }

          case "connect": {
            if (!input.cdp_url)
              return { error: "connect requires 'cdp_url'" };
            const msg = await bm.connect(String(input.cdp_url));
            return { result: msg };
          }

          case "status": {
            return bm.status();
          }

          case "close": {
            const msg = await bm.close();
            return { result: msg };
          }

          case "open": {
            if (!input.url) return { error: "open requires 'url'" };
            await ensureConnectedForPageAction();
            const url = String(input.url);

            // A site with a configured browser-session descriptor keeps a
            // logged-in session whose cookies expire on their own schedule.
            // Heal it here so navigating never lands on a sign-in page.
            let session: Record<string, unknown> | undefined;
            const target = siteScopeForUrl(url);
            if (target) {
              const restored = await ensureSiteSession({
                site: target.site.id,
                scope: target.scope.id,
                url,
              });
              session = {
                site: restored.site,
                scope: restored.scope,
                authenticated: restored.authenticated,
                path: restored.path,
                message: restored.message,
                ...(restored.needsSecondFactor ? { needsSecondFactor: true } : {}),
              };
            }

            const msg = await bm.open(url);
            return session ? { result: msg, site_session: session } : { result: msg };
          }

          case "snapshot": {
            await ensureConnectedForPageAction();
            const snapshot = await bm.snapshot({
              interactive: input.interactive === true,
            });
            return { result: snapshot };
          }

          case "screenshot": {
            await ensureConnectedForPageAction();
            const filePath = await bm.screenshot({
              fullPage: input.full_page === true,
              ref: typeof input.ref === "number" ? input.ref : undefined,
              selector: typeof input.selector === "string" ? input.selector : undefined,
            });
            return {
              screenshot_path: filePath,
              note:
                "This file is NOT visible to the user. To show it to them, call "
                + "discord_send_image with this path as `source` — only a returned "
                + "message_id means the user can see it.",
            };
          }

          case "click": {
            if (typeof input.ref !== "number")
              return { error: "click requires 'ref' (number)" };
            await ensureConnectedForPageAction();
            const msg = await bm.click(input.ref as number);
            return { result: msg };
          }

          case "fill": {
            if (typeof input.ref !== "number")
              return { error: "fill requires 'ref' (number)" };
            if (!input.value) return { error: "fill requires 'value'" };
            await ensureConnectedForPageAction();
            const msg = await bm.fill(
              input.ref as number,
              String(input.value),
            );
            return { result: msg };
          }

          case "upload": {
            if (typeof input.ref !== "number")
              return { error: "upload requires 'ref' (number)" };
            if (!Array.isArray(input.files) || input.files.length === 0)
              return { error: "upload requires 'files' (string array)" };
            await ensureConnectedForPageAction();
            const msg = await bm.upload(
              input.ref as number,
              (input.files as string[]).map(String),
            );
            return { result: msg };
          }

          case "type": {
            if (typeof input.ref !== "number")
              return { error: "type requires 'ref' (number)" };
            if (!input.value) return { error: "type requires 'value'" };
            await ensureConnectedForPageAction();
            const msg = await bm.type(
              input.ref as number,
              String(input.value),
            );
            return { result: msg };
          }

          case "press": {
            if (!input.key) return { error: "press requires 'key'" };
            await ensureConnectedForPageAction();
            const msg = await bm.press(String(input.key));
            return { result: msg };
          }

          case "select": {
            if (typeof input.ref !== "number")
              return { error: "select requires 'ref' (number)" };
            if (!Array.isArray(input.values))
              return { error: "select requires 'values' (string array)" };
            await ensureConnectedForPageAction();
            const msg = await bm.select(
              input.ref as number,
              (input.values as string[]).map(String),
            );
            return { result: msg };
          }

          case "scroll": {
            if (!input.direction)
              return { error: "scroll requires 'direction'" };
            await ensureConnectedForPageAction();
            const msg = await bm.scroll(
              input.direction as "up" | "down",
              typeof input.pixels === "number"
                ? (input.pixels as number)
                : undefined,
            );
            return { result: msg };
          }

          case "wait": {
            await ensureConnectedForPageAction();
            const msg = await bm.wait({
              text: input.text ? String(input.text) : undefined,
              selector: input.selector ? String(input.selector) : undefined,
              timeout:
                typeof input.timeout === "number"
                  ? (input.timeout as number)
                  : undefined,
            });
            return { result: msg };
          }

          case "eval": {
            if (!input.script) return { error: "eval requires 'script'" };
            await ensureConnectedForPageAction();
            const result = await bm.evaluate(String(input.script));
            return { result };
          }

          default:
            return { error: `Unknown action: ${action}` };
        }
      },
    },
  ];
}
