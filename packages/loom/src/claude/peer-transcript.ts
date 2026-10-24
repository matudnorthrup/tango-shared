import { closeSync, openSync, readSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

/**
 * Messages from another Claude session (native cross-session messaging) as the session's own
 * transcript records them. The harness never echoes them on the SDK stream, but the transcript keeps
 * each one as a user entry with `origin: { kind: 'peer', name, from, body, msg_id }`, and marks a turn
 * one started with `turnOrigin: 'peer'`.
 */
export interface PeerEntry {
  text: string;
  name?: string;
  address?: string;
  messageId: string;
  /** Read mid-turn, rather than starting a turn of its own. */
  inline: boolean;
  /** When the transcript recorded it (epoch ms), if it says. */
  at?: number;
}

export function peerEntryOf(line: string): PeerEntry | null {
  let entry: Record<string, any>;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  const origin = entry?.origin;
  if (entry?.type !== "user" || origin?.kind !== "peer") return null;
  const content = entry.message?.content;
  const raw = typeof content === "string" ? content : Array.isArray(content) ? content.map((b: any) => (typeof b?.text === "string" ? b.text : "")).join("") : "";
  // The decoded body when the harness gives it; else the text inside the envelope.
  const text = typeof origin.body === "string" ? origin.body : (/<cross-session-message[^>]*>\n?([\s\S]*?)\n?<\/cross-session-message>/.exec(raw)?.[1] ?? raw);
  if (!text.trim()) return null;
  const messageId = typeof origin.msg_id === "string" ? origin.msg_id : typeof entry.uuid === "string" ? entry.uuid : "";
  if (!messageId) return null;
  return {
    text: text.trim(),
    ...(typeof origin.name === "string" && origin.name ? { name: origin.name } : {}),
    ...(typeof origin.from === "string" && origin.from ? { address: origin.from } : {}),
    messageId,
    inline: entry.turnOrigin !== "peer",
    ...(Number.isFinite(Date.parse(entry.timestamp)) ? { at: Date.parse(entry.timestamp) } : {}),
  };
}

/** Reads a transcript as it grows: only what was appended since the last read. */
export class TranscriptTail {
  private offset: number;
  private carry = "";
  /** Keeps a character split across two reads whole (Codex review on #575). */
  private decoder = new StringDecoder("utf8");

  /** `fromEnd`: skip what is already there (a resumed session's history was read before). */
  constructor(private readonly file: string, fromEnd: boolean) {
    this.offset = fromEnd ? sizeOf(file) : 0;
  }

  /** New complete lines since the last call. */
  lines(): string[] {
    const size = sizeOf(this.file);
    if (size < this.offset) {
      this.offset = 0;
      this.carry = "";
      this.decoder = new StringDecoder("utf8");
    }
    if (size === this.offset) return [];
    let fd: number;
    try {
      fd = openSync(this.file, "r");
    } catch {
      return [];
    }
    try {
      const buf = Buffer.alloc(size - this.offset);
      const read = readSync(fd, buf, 0, buf.length, this.offset);
      this.offset += read;
      const text = this.carry + this.decoder.write(buf.subarray(0, read));
      const parts = text.split("\n");
      this.carry = parts.pop() ?? "";
      return parts.filter((line) => line.trim());
    } finally {
      closeSync(fd);
    }
  }
}

function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}
