import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { request, type RequestOptions } from "node:http";
import { randomUUID } from "node:crypto";
import { inspectProcess, type ProcessIdentity } from "./managed-process.js";
import { inspectMappingConfig, mappingRemoval, type MappingIdentity, type MappingReservation, type ServeConfig } from "./managed-mapping.js";
import { killGroup } from "./proc.js";

const exec = promisify(execFile);
/** Credentials stay in memory/IPC, never argv, logs, or the durable lease. */
export async function localApiOptions(): Promise<RequestOptions> {
  const { stdout } = await exec("tailscale", ["debug", "local-creds"], { timeout: 5000, maxBuffer: 8192 });
  const tcp = stdout.trim().match(/^curl -u:([^\s]+) http:\/\/localhost:(\d+)\/localapi\/v0\/status$/);
  if (tcp) return { hostname: "127.0.0.1", port: Number(tcp[2]), headers: { Authorization: `Basic ${Buffer.from(`:${tcp[1]}`).toString("base64")}` } };
  const unix = stdout.trim().match(/^curl --unix-socket (\/[^\s]+) http:\/\/local-tailscaled.sock\/localapi\/v0\/status$/);
  if (unix) return { socketPath: unix[1], hostname: "local-tailscaled.sock" };
  throw new Error("Cannot locate Tailscale LocalAPI; check tailscale debug local-creds locally");
}
export async function serveRequest(options: RequestOptions, method: string, path: string, body?: unknown, etag?: string): Promise<{ value: any; etag?: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ ...options, method, path: `/localapi/v0/${path}`, headers: { ...options.headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(etag ? { "If-Match": etag } : {}) } }, res => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { data += chunk; if (data.length > 2 * 1024 * 1024) req.destroy(new Error("Tailscale response too large")); });
      res.on("error", reject);
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`Tailscale LocalAPI returned ${res.statusCode}; inspect Serve status before retrying`));
        try { resolve({ value: data ? JSON.parse(data) : null, etag: res.headers.etag }); } catch { reject(new Error("Invalid Tailscale response")); }
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error("Tailscale LocalAPI timed out")));
    req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
export async function serveStatus(connection?: RequestOptions): Promise<ServeConfig> {
  return (await serveRequest(connection ?? await localApiOptions(), "GET", "serve-config")).value ?? {};
}
export function portOccupied(config: ServeConfig, port: number): boolean {
  return Object.hasOwn(config.TCP ?? {}, String(port)) || Object.keys(config.Web ?? {}).some(k => k.endsWith(`:${port}`)) ||
    Object.keys(config.AllowFunnel ?? {}).some(k => k.endsWith(`:${port}`)) || Object.values(config.Foreground ?? {}).some(c => portOccupied(c, port));
}
export async function removeServeSession(identity: MappingIdentity): Promise<void> {
  const options = await localApiOptions();
  const snapshot = await serveRequest(options, "GET", "serve-config");
  const config = snapshot.value ?? {};
  const state = inspectMappingConfig(identity, config);
  if (state === "gone") return;
  if (state !== "same" || !snapshot.etag) throw new Error("Mapping ownership or ETag changed; preserve it and inspect Serve status");
  await serveRequest(options, "POST", "serve-config", mappingRemoval(identity, config), snapshot.etag);
}

// This process owns exactly one WatchIPNBus connection. It remains foreground in its
// nonce-marked group, survives coordinator restart, and never reconnects or publishes.
const watcher = `
const {request}=require('node:http');
let active=false, req;
const timer=setTimeout(()=>process.exit(1),10000);
process.on('disconnect',()=>{if(!active)process.exit(1)});
process.on('message',m=>{
 if(m.activate){active=true;clearTimeout(timer);process.disconnect();return;}
 req=request({...m.options,path:'/localapi/v0/watch-ipn-bus?mask=2'},res=>{
  if(res.statusCode!==200)process.exit(1);
  let buffer='',sent=false;res.setEncoding('utf8');
  res.on('data',chunk=>{if(sent)return;buffer+=chunk;if(buffer.length>1048576)process.exit(1);
   const end=buffer.indexOf('\\n');if(end<0)return;
   try{const value=JSON.parse(buffer.slice(0,end));if(!value.SessionID)process.exit(1);sent=true;process.send({sessionId:value.SessionID});}catch{process.exit(1)}
  });
  res.on('end',()=>process.exit(1));res.on('error',()=>process.exit(1));
 });req.on('error',()=>process.exit(1));req.end();
});
`;
export async function reserveServeMapping(localPort: number, httpsPort: number, connection?: RequestOptions): Promise<MappingReservation> {
  for (const port of [localPort, httpsPort]) if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Port must be between 1 and 65535");
  const options = connection ?? await localApiOptions();
  const status = await serveRequest(options, "GET", "status");
  const dns = String(status.value?.Self?.DNSName ?? "").replace(/\.$/, "");
  if (!/^[a-z0-9.-]+$/i.test(dns)) throw new Error("Tailscale DNS name unavailable; connect Tailscale before retrying");
  const nonce = randomUUID();
  const child = spawn(process.execPath, ["-e", watcher, `loom-managed-${nonce}`], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  let processIdentity: ProcessIdentity | undefined;
  const abort = async () => {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    // Before identity capture this is still our unreaped direct child. Once
    // captured, also require the nonce/start-time/group check before signaling.
    if (!processIdentity || inspectProcess(processIdentity) === "same") killGroup(child.pid);
  };
  try {
    const sessionId = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => done(new Error("Tailscale watcher did not become ready")), 5000);
      const done = (error?: Error, session?: string) => { clearTimeout(timer); child.off("error", fail); child.off("exit", exited); child.off("message", ready); error ? reject(error) : resolve(session!); };
      const fail = (e: Error) => done(e); const exited = () => done(new Error("Tailscale watcher exited"));
      const ready = (m: any) => typeof m?.sessionId === "string" && m.sessionId ? done(undefined, m.sessionId) : done(new Error("Missing Tailscale session ID"));
      child.once("error", fail); child.once("exit", exited); child.once("message", ready);
      child.send({ options }, error => { if (error) fail(error); });
    });
    processIdentity = { pid: child.pid!, started: execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(child.pid)], { encoding: "utf8", timeout: 2000 }).trim(), uid: process.getuid!(), nonce };
    if (inspectProcess(processIdentity) !== "same") throw new Error("Cannot verify Tailscale watcher ownership");
    const identity: MappingIdentity = { sessionId, process: processIdentity, httpsPort, config: { TCP: { [httpsPort]: { HTTPS: true } }, Web: { [`${dns}:${httpsPort}`]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${localPort}` } } } } } };
    return {
      identity,
      abort,
      activate: async () => {
        // Registration has completed. Retain the watcher even on an uncertain POST outcome.
        await new Promise<void>((resolve, reject) => child.send({ activate: true }, error => error ? reject(error) : resolve()));
        child.unref();
        const snapshot = await serveRequest(options, "GET", "serve-config");
        const config: ServeConfig = snapshot.value ?? {};
        if (!snapshot.etag || portOccupied(config, httpsPort) || config.Foreground?.[sessionId]) throw new Error("Serve port is occupied or ownership cannot be proven; choose a fresh HTTPS port");
        if (inspectProcess(identity.process) !== "same") throw new Error("Tailscale watcher exited before activation");
        config.Foreground = { ...config.Foreground, [sessionId]: identity.config };
        await serveRequest(options, "POST", "serve-config", config, snapshot.etag);
      },
    };
  } catch (error) { await abort(); throw error; }
}
