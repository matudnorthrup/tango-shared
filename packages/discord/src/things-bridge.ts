import { spawn } from "node:child_process";

// Fixed code, JSON over stdin: task text is never evaluated or passed to a shell.
export const THINGS_JXA = String.raw`
ObjC.import('Foundation');
function run() {
  var data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  var p = JSON.parse($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js);
  var app = Application('com.culturedcode.ThingsMac');
  if (p.operation === 'doctor') return JSON.stringify({version:app.version(), automation:true});
  if (p.operation === 'list') {
    return JSON.stringify({ids:app.lists.byName(p.list).toDos.id()});
  }
  throw new Error('Unsupported read operation');
}`;

export type ThingsBridge = (input: Record<string, unknown>) => Promise<Record<string, unknown>>;

// AppleScript's date clearing and move commands do not marshal reliably through
// JXA. Use native AppleScript for mutations; all data is escaped as literals.
function literal(value: unknown): string {
  return '"' + String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')
    .replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t") + '"';
}

export function thingsWriteScript(p: Record<string, unknown>): string {
  const cls = ({ todo: "to do", project: "project", area: "area", tag: "tag" } as Record<string, string>)[String(p.kind)];
  if (!cls || !["create", "update", "trash"].includes(String(p.operation))) throw new Error("Invalid Things mutation");
  const lines = ['set itemId to ' + literal(p.id ?? ""), 'try', 'tell application "Things3"'];
  if (p.project_id) lines.push(`set parentItem to project id ${literal(p.project_id)}`);
  if (p.area_id) lines.push(`set parentItem to area id ${literal(p.area_id)}`);
  if (p.operation === "create") {
    lines.push(`set targetItem to make new ${cls} with properties {name:${literal(p.title)}}`, 'set itemId to id of targetItem');
  } else lines.push(`set targetItem to ${cls} id itemId`);
  if (p.operation === "trash") lines.push("delete targetItem");
  else {
    if (p.title !== undefined) lines.push(`set name of targetItem to ${literal(p.title)}`);
    if (p.notes !== undefined) lines.push(`set notes of targetItem to ${literal(p.notes)}`);
    if (p.tags !== undefined) lines.push(`set tag names of targetItem to ${literal((p.tags as string[]).join(", "))}`);
    if (p.project_id) lines.push("set project of targetItem to parentItem");
    if (p.area_id) lines.push("set area of targetItem to parentItem");
    function dateLines(value: unknown): string[] {
      const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
      if (!parts) throw new Error("Invalid Things date");
      return ['set targetDate to current date', 'set day of targetDate to 1', `set year of targetDate to ${Number(parts[1])}`,
        `set month of targetDate to ${Number(parts[2])}`, `set day of targetDate to ${Number(parts[3])}`, 'set time of targetDate to 43200'];
    }
    if (p.deadline === null) lines.push("delete due date of targetItem");
    else if (p.deadline !== undefined) lines.push(...dateLines(p.deadline), 'set due date of targetItem to targetDate');
    if (p.when !== undefined) {
      const list = ({ today: "Today", anytime: "Anytime", someday: "Someday", inbox: "Inbox" } as Record<string, string>)[String(p.when)];
      if (list) lines.push(`move targetItem to list ${literal(list)}`);
      else lines.push(...dateLines(p.when), "schedule targetItem for targetDate");
    }
    if (p.status !== undefined) {
      if (!["open", "completed", "canceled"].includes(String(p.status))) throw new Error("Invalid Things status");
      lines.push(`set status of targetItem to ${p.status}`);
    }
  }
  lines.push('end tell', 'return "ok:" & itemId', 'on error errorMessage number errorNumber',
    'return "error:" & itemId & ":" & errorNumber', 'end try');
  return lines.join("\n");
}

export function runThingsBridge(input: Record<string, unknown>, timeoutMs = 15_000): Promise<Record<string, unknown>> {
  if (process.platform !== "darwin") return Promise.reject(new Error("Things automation requires macOS."));
  return new Promise((resolve, reject) => {
    const isRead = input.operation === "doctor" || input.operation === "list";
    const script = isRead ? JSON.stringify(input) : thingsWriteScript(input);
    const child = spawn("/usr/bin/osascript", isRead ? ["-l", "JavaScript", "-e", THINGS_JXA] : ["-"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
    child.stdin.on("error", () => { /* close/error reports the outcome */ });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error("Things automation timed out. Check macOS Automation permission for the Tango host and any Things dialog. A write may have applied; read back before retrying."));
      } else if (code !== 0) {
        // Do not include task text or arbitrary application diagnostics in logs.
        reject(new Error(stderr.includes("-1743") ? "macOS denied Automation access to Things for this host." : "Things automation failed. Check the app and macOS Automation permission."));
      } else {
        try {
          if (isRead) resolve(JSON.parse(stdout) as Record<string, unknown>);
          else if (stdout.trim().startsWith("ok:")) resolve({ id: stdout.trim().slice(3) });
          else if (stdout.trim().startsWith("error:")) {
            const [, itemId, errorCode] = stdout.trim().split(":");
            resolve({ id: itemId || null, error: errorCode, outcome: "unknown", retry_safe: false });
          } else throw new Error("Invalid reply");
        }
        catch { reject(new Error("Things returned an invalid automation response; read back before retrying a write.")); }
      }
    });
    child.stdin.end(script);
  });
}
