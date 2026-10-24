import { execSync } from "node:child_process";

// Which process owns a local service, found by its command line (`ps`), not by
// its socket. lsof stats every open file, so a stalled network mount (an SMB
// share whose server stops answering) blocks it in uninterruptible I/O forever:
// that froze the bot at startup on 10/05. netstat avoids that but, on macOS 27,
// lists no sockets at all from this context. `ps` needs neither.

/** Processes whose command line matches, excluding this process. */
export function pidsByCommand(matches: (command: string) => boolean, psOutput?: string): number[] {
  let output = psOutput;
  if (output === undefined) {
    try {
      output = execSync("ps -axo pid=,command=", { encoding: "utf8", timeout: 5000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return [];
    }
  }
  const pids: number[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid !== process.pid && matches(match[2]!)) pids.push(pid);
  }
  return pids;
}

/** The persistent MCP server started for `port` (`mcp-wellness-server.js --http --port=<port>`). */
export function mcpServerPids(port: number, psOutput?: string): number[] {
  return pidsByCommand((command) => command.includes("mcp-wellness-server") && new RegExp(`--port=${port}(\\s|$)`).test(command), psOutput);
}

/**
 * The MCP servers on `port` this bot may stop before starting its own: an
 * orphan left by a bot that died (its parent is now launchd, pid 1) or this
 * bot's own child. A server another running bot owns — another checkout, a
 * test run — is never ours to kill; SIGTERMing it took the live bot's tools
 * down on 10/19 (system incident #104). Reads `ps -axo pid=,ppid=,command=`.
 */
export function staleMcpServerPids(port: number, psOutput?: string, selfPid = process.pid): number[] {
  let output = psOutput;
  if (output === undefined) {
    try {
      output = execSync("ps -axo pid=,ppid=,command=", { encoding: "utf8", timeout: 5000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return [];
    }
  }
  const pids: number[] = [];
  const portFlag = new RegExp(`--port=${port}(\\s|$)`);
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const command = match[3]!;
    if (pid === selfPid || !command.includes("mcp-wellness-server") || !portFlag.test(command)) continue;
    if (ppid === 1 || ppid === selfPid) pids.push(pid);
  }
  return pids;
}

/**
 * The port this bot's MCP server should use: `configured`, unless an MCP server
 * another running bot owns is already on it. Then the next port up with no MCP
 * server and nothing listening, so this bot's clients (mcp-proxy, the Ollama
 * tool client) never reach the other bot's server, which reads the other
 * checkout's profile and database. Falls back to `configured` if none is free.
 */
export function chooseMcpPort(
  configured: number,
  probe: {
    foreignPids: (port: number) => number[];
    listening: (port: number) => boolean;
  } = {
    foreignPids: (port) => {
      const stale = staleMcpServerPids(port);
      return mcpServerPids(port).filter((pid) => !stale.includes(pid));
    },
    listening: portIsListening,
  },
  span = 50,
): number {
  if (probe.foreignPids(configured).length === 0) return configured;
  for (let port = configured + 1; port <= configured + span; port++) {
    if (probe.foreignPids(port).length === 0 && !probe.listening(port)) return port;
  }
  return configured;
}

/** Whether something accepts TCP connections on 127.0.0.1:`port` (`nc -z`, no lsof). */
export function portIsListening(port: number): boolean {
  try {
    execSync(`nc -z -G 1 127.0.0.1 ${port}`, { timeout: 3000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** The browser's main process serving CDP on `port` (not its helper processes). */
export function cdpBrowserPids(port: number, psOutput?: string): number[] {
  return pidsByCommand((command) => new RegExp(`--remote-debugging-port=${port}(\\s|$)`).test(command) && !/\s--type=/.test(command), psOutput);
}
