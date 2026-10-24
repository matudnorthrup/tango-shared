import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import type { ResourceLeases } from "./leases.js";
import { createManagedProcess, inspectProcess, type ProcessIdentity } from "./managed-process.js";
import { inspectBrowserProfile } from "./browser-profile.js";

const exec = promisify(execFile);
/** lsof can block in the kernel on macOS mounts even after SIGKILL. Bound
 * our wait and detach its pipes; failure never establishes port ownership. */
function listenerInfo(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof", args, { maxBuffer: 1024 * 1024 }, (error, stdout) => {
      clearTimeout(timer); error && error.code !== 1 ? reject(error) : resolve(stdout);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL"); child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
      reject(new Error("Browser listener inspection timed out; ownership is unknown"));
    }, 2000);
  });
}
export function chromeExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = env.LOOM_CHROME_PATH ? [env.LOOM_CHROME_PATH] : process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
    : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  const command = candidates.find(path => path.startsWith("/") && existsSync(path));
  if (!command) throw new Error("Chrome unavailable; configure LOOM_CHROME_PATH on the coordinator to an installed Chrome executable");
  return command;
}

/** A free-port probe is not ownership. Verify the actual listener's group after
 * Chrome binds, with the nonce-verified supervisor and exclusive profile intact. */
export async function browserReady(home: string, identity: ProcessIdentity): Promise<boolean> {
  if (!identity.browser || !identity.profile || inspectProcess(identity) !== "same" || inspectBrowserProfile(home, identity.profile) !== "same") return false;
  const { stdout: processes } = await exec("/bin/ps", ["-axo", "pid=,pgid="], { timeout: 2000 });
  const pids = processes.split("\n").flatMap(line => {
    const fields = line.trim().split(/\s+/);
    return fields.length === 2 && Number(fields[1]) === identity.pid ? [fields[0]!] : [];
  });
  if (!pids.length) return false;
  const stdout = await listenerInfo(["-a", "-b", "-w", "-p", pids.join(","), "-nP", `-iTCP:${identity.browser.port}`, "-sTCP:LISTEN", "-Fpg"]);
  const groups = stdout.split("\n").filter(line => line.startsWith("g"));
  if (!groups.length || groups.some(line => line !== `g${identity.pid}`)) return false;
  const response = await fetch(`http://127.0.0.1:${identity.browser.port}/json/version`, { signal: AbortSignal.timeout(1000) });
  const version = await response.json() as { webSocketDebuggerUrl?: string };
  if (!response.ok || !version.webSocketDebuggerUrl) return false;
  const url = new URL(version.webSocketDebuggerUrl);
  return url.protocol === "ws:" && ["127.0.0.1", "localhost"].includes(url.hostname) && Number(url.port) === identity.browser.port && url.pathname.startsWith("/devtools/browser/") && inspectProcess(identity) === "same";
}

export async function createManagedBrowser(leases: ResourceLeases, home: string, input: {
  threadId: string; runId: string; cwd: string;
}, launch = { command: chromeExecutable(), args: [] as string[] }) {
  const previous = leases.list(input.threadId).find(row => row.kind === "browser" && row.run_id === input.runId && row.state !== "reclaimed" && JSON.parse(row.identity).browser);
  if (previous) {
    const identity = JSON.parse(previous.identity) as ProcessIdentity;
    if (previous.state === "active" && await browserReady(home, identity).catch(() => false)) return { lease: previous, browser: identity.browser! };
    await leases.release(previous.id, input.threadId);
    if (leases.list().find(row => row.id === previous.id)?.state !== "reclaimed") throw new Error("Browser ownership changed; inspect resources before retrying");
  }
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve); });
  const port = (reservation.address() as AddressInfo).port;
  const releasePort = async () => { if (reservation.listening) await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve())); };
  let created: Awaited<ReturnType<typeof createManagedProcess>> | undefined;
  try {
    created = await createManagedProcess(leases, home, { ...input, ...launch, kind: "browser", profile: "exclusive", managedBrowser: { port, releasePort } });
    const identity = JSON.parse(created.lease.identity) as ProcessIdentity;
    const deadline = Date.now() + 10_000;
    do {
      if (await browserReady(home, identity).catch(() => false)) return { ...created, browser: identity.browser! };
      if (inspectProcess(identity) === "gone") break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    throw new Error("Managed Chrome did not open its owned CDP port; check the Chrome installation and inspect resources before retrying");
  } catch (error) {
    if (created) await leases.release(created.lease.id, input.threadId);
    throw error;
  } finally { await releasePort(); }
}
