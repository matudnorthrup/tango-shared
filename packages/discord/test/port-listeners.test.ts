import { describe, expect, it } from "vitest";
import { cdpBrowserPids, chooseMcpPort, mcpServerPids, staleMcpServerPids } from "../src/port-listeners.js";

const PS = `  101 /usr/bin/node packages/discord/dist/mcp-wellness-server.js --http --port=9100
  102 /usr/bin/node /other/checkout/packages/discord/dist/mcp-wellness-server.js --http --port=19100
  103 /usr/bin/node packages/discord/dist/main.js
31378 /Applications/Brave Browser.app/Contents/MacOS/Brave Browser --remote-debugging-port=9223 --remote-debugging-address=127.0.0.1 --user-data-dir=/tmp/browser-profile
 3199 /Applications/Brave Browser.app/Contents/Frameworks/Brave Browser Helper (Renderer).app/Contents/MacOS/Brave Browser Helper (Renderer) --type=renderer --remote-debugging-port=9223
 4000 /Applications/Brave Browser.app/Contents/MacOS/Brave Browser --remote-debugging-port=92230`;

describe("finding service processes by command line", () => {
  it("finds this checkout's MCP server by its port, not another checkout's", () => {
    expect(mcpServerPids(9100, PS)).toEqual([101]);
    expect(mcpServerPids(19100, PS)).toEqual([102]);
  });

  it("only offers to kill an orphaned MCP server or this bot's own, never another running bot's", () => {
    const ps = `  201     1 /usr/bin/node packages/discord/dist/mcp-wellness-server.js --http --port=9100
  202   500 /usr/bin/node packages/discord/dist/mcp-wellness-server.js --http --port=9100
  203   777 /usr/bin/node /other/checkout/packages/discord/dist/mcp-wellness-server.js --http --port=9100
  204   500 /usr/bin/node packages/discord/dist/mcp-wellness-server.js --http --port=19100
  500   400 /usr/bin/node packages/discord/dist/main.js`;
    expect(staleMcpServerPids(9100, ps, 500)).toEqual([201, 202]);
    expect(staleMcpServerPids(19100, ps, 500)).toEqual([204]);
    expect(staleMcpServerPids(9100, ps, 600)).toEqual([201]);
  });

  it("moves off a port another running bot's MCP server owns, to the next free one", () => {
    const foreign = new Set([9100, 9101]);
    const listening = new Set([9102]);
    const probe = { foreignPids: (p: number) => (foreign.has(p) ? [1] : []), listening: (p: number) => listening.has(p) };
    expect(chooseMcpPort(9100, probe)).toBe(9103);
    expect(chooseMcpPort(9200, probe)).toBe(9200);
    expect(chooseMcpPort(9100, { foreignPids: () => [1], listening: () => false }, 5)).toBe(9100);
  });

  it("finds the browser's main process for a CDP port, not its helpers or a longer port", () => {
    expect(cdpBrowserPids(9223, PS)).toEqual([31378]);
  });

  it("finds the real processes on this machine without hanging", () => {
    expect(Array.isArray(cdpBrowserPids(9223))).toBe(true);
  });
});
