/**
 * Research Agent Tools — Tool definitions for Sierra (research/procurement) worker agents.
 *
 * Tools:
 *   - exa_search: Web search via EXA API (neural search)
 *   - exa_answer: Quick factual answers via EXA
 *   - printer_command: PrusaLink API for 3D printer management
 *   - openscad_render: Render OpenSCAD files to STL
 *   - prusa_slice: Slice STL files to G-code via PrusaSlicer
 *   - paper_print: macOS paper printer PDF preview and print jobs
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { spawn } from "node:child_process";
import {
  resolveConfiguredPath,
  resolveLegacyDataDir,
  resolveTangoHome,
  resolveTangoProfileDataDir,
  resolveTangoProfileDir,
  type AgentTool,
} from "@tango/core";
import { getSecret } from "./op-secret.js";
import {
  addToQueue,
  listQueue,
  clearQueue,
  removeFromQueue,
  loadQueue,
  summarizePreferences,
  type CartQueueItem,
} from "./walmart-cart-processor.js";
import {
  parseReceipts,
  analyzeHistory,
  getRestockRecommendations,
} from "./walmart-history-parser.js";

// ---------------------------------------------------------------------------
// Command runner (shared)
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
    const spawnEnv = env ? { ...process.env, ...env } : undefined;
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], ...(spawnEnv ? { env: spawnEnv } : {}) });

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

function execCommandBuffer(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: Buffer; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    let stderr = "";
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 2000).unref();
    }, timeoutMs);
    timer.unref();

    child.stdout.on("data", (chunk: Buffer) => { stdoutChunks.push(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(stdoutChunks), stderr, code });
    });
    child.stdin.end();
  });
}

async function runCommand(
  command: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<string> {
  const result = await execCommand(command, args, timeoutMs);
  if (result.code !== 0 && result.stderr) {
    return `Error (exit ${result.code}): ${result.stderr.trim()}\n${result.stdout.trim()}`.trim();
  }
  return result.stdout.trim();
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

export interface ResearchToolPaths {
  exaSearchScript?: string;
  exaAnswerScript?: string;
  openscadCommand?: string;
  prusaSlicerCommand?: string;
  printingDir?: string;
  prusaPrinterIp?: string;
  prusaApiKey?: string;
  paperPrintDir?: string;
  cupsfilterCommand?: string;
  lpCommand?: string;
  lpstatCommand?: string;
  textutilCommand?: string;
  pdfinfoCommand?: string;
}

function resolveExistingOrFallback(candidates: string[], fallback: string): string {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return fallback;
}

function resolveConfiguredOrFallback(
  configured: string | undefined,
  candidates: string[],
  fallback: string,
): string {
  const normalized = configured?.trim();
  if (normalized && normalized.length > 0) {
    return resolveConfiguredPath(normalized);
  }
  return resolveExistingOrFallback(candidates, fallback);
}

function resolvePaths(overrides?: ResearchToolPaths) {
  const home = os.homedir();
  const tangoHome = resolveTangoHome();
  const profileDir = resolveTangoProfileDir();
  const genericExaSearchScript = path.join(tangoHome, "tools/research/exa-search.js");
  const legacyExaSearchScript = path.join(home, "legacy-agent/scripts/exa-search.js");
  const genericExaAnswerScript = path.join(tangoHome, "tools/research/exa-answer.js");
  const legacyExaAnswerScript = path.join(home, "legacy-agent/scripts/exa-answer.js");
  const genericPrintingDir = path.join(profileDir, "projects", "3d-printing");
  const legacyPrintingDir = path.join(home, "3d-printing");
  const genericPaperPrintDir = path.join(profileDir, "data", "paper-print");
  return {
    exaSearchScript: overrides?.exaSearchScript ?? resolveConfiguredOrFallback(
      process.env.TANGO_EXA_SEARCH_SCRIPT,
      [genericExaSearchScript, legacyExaSearchScript],
      genericExaSearchScript,
    ),
    exaAnswerScript: overrides?.exaAnswerScript ?? resolveConfiguredOrFallback(
      process.env.TANGO_EXA_ANSWER_SCRIPT,
      [genericExaAnswerScript, legacyExaAnswerScript],
      genericExaAnswerScript,
    ),
    openscadCommand: overrides?.openscadCommand ?? resolveConfiguredOrFallback(
      process.env.TANGO_OPENSCAD_COMMAND,
      ["/opt/homebrew/bin/openscad"],
      "/opt/homebrew/bin/openscad",
    ),
    prusaSlicerCommand: overrides?.prusaSlicerCommand ?? resolveConfiguredOrFallback(
      process.env.TANGO_PRUSA_SLICER_COMMAND,
      [path.join(home, "bin/prusa-slicer")],
      path.join(home, "bin/prusa-slicer"),
    ),
    printingDir: overrides?.printingDir ?? resolveConfiguredOrFallback(
      process.env.TANGO_PRINTING_DIR,
      [genericPrintingDir, legacyPrintingDir],
      genericPrintingDir,
    ),
    prusaPrinterIp: overrides?.prusaPrinterIp ?? process.env.TANGO_PRUSA_PRINTER_HOST ?? "printer.local",
    prusaApiKey: overrides?.prusaApiKey ?? undefined,
    paperPrintDir: overrides?.paperPrintDir ?? resolveConfiguredOrFallback(
      process.env.TANGO_PAPER_PRINT_DIR,
      [genericPaperPrintDir],
      genericPaperPrintDir,
    ),
    cupsfilterCommand: overrides?.cupsfilterCommand ?? resolveConfiguredOrFallback(
      process.env.TANGO_CUPSFILTER_COMMAND,
      ["/usr/sbin/cupsfilter"],
      "/usr/sbin/cupsfilter",
    ),
    lpCommand: overrides?.lpCommand ?? resolveConfiguredOrFallback(
      process.env.TANGO_LP_COMMAND,
      ["/usr/bin/lp"],
      "/usr/bin/lp",
    ),
    lpstatCommand: overrides?.lpstatCommand ?? resolveConfiguredOrFallback(
      process.env.TANGO_LPSTAT_COMMAND,
      ["/usr/bin/lpstat"],
      "/usr/bin/lpstat",
    ),
    textutilCommand: overrides?.textutilCommand ?? resolveConfiguredOrFallback(
      process.env.TANGO_TEXTUTIL_COMMAND,
      ["/usr/bin/textutil"],
      "/usr/bin/textutil",
    ),
    pdfinfoCommand: overrides?.pdfinfoCommand ?? resolveConfiguredOrFallback(
      process.env.TANGO_PDFINFO_COMMAND,
      ["/opt/homebrew/bin/pdfinfo", "/usr/local/bin/pdfinfo", "/usr/bin/pdfinfo"],
      "pdfinfo",
    ),
  };
}

// Resolve EXA API key from 1Password
async function resolveExaApiKey(): Promise<string> {
  const opKey = await getSecret("Watson", "EXA API Key");
  if (opKey) return opKey;
  throw new Error("EXA API key not found in 1Password (Watson vault, item 'EXA API Key')");
}

// Resolve PrusaLink API key: 1Password → no fallback (was hardcoded)
async function resolvePrusaApiKey(): Promise<string> {
  const opKey = await getSecret("Watson", "PrusaLink API Key");
  if (opKey) return opKey;
  throw new Error("PrusaLink API key not found in 1Password (Watson vault, item 'PrusaLink API Key')");
}

// ---------------------------------------------------------------------------
// EXA Search
// ---------------------------------------------------------------------------

export function createExaTools(overrides?: ResearchToolPaths): AgentTool[] {
  const paths = resolvePaths(overrides);

  // Cached EXA API key — resolved from 1Password with file fallback
  let cachedExaKey: string | null = null;
  async function getExaKey(): Promise<string> {
    if (!cachedExaKey) {
      cachedExaKey = await resolveExaApiKey();
    }
    return cachedExaKey;
  }

  return [
    {
      name: "exa_search",
      description: [
        "Search the web using EXA's neural search API. Understands intent, not just keywords.",
        "",
        "Options:",
        "  query (required): Search query string",
        "  num: Number of results (default 10, max 25)",
        "  text: Include full page text in results (costs more, use for deep analysis)",
        "  highlights: Include key highlights (lighter than full text)",
        "  category: Filter by category — news, research paper, tweet, company, people",
        "",
        "Cost: ~$0.005 per search. Rate limit: 5 QPS.",
        "Use for: Research questions, current events, product comparisons, finding sources.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          num: { type: "number", description: "Number of results (default 10)" },
          text: { type: "boolean", description: "Include full page text (default false)" },
          highlights: { type: "boolean", description: "Include highlights (default false)" },
          category: { type: "string", enum: ["news", "research paper", "tweet", "company", "people"], description: "Category filter" },
        },
        required: ["query"],
      },
      handler: async (input) => {
        const apiKey = await getExaKey();
        const args: string[] = [paths.exaSearchScript, String(input.query)];
        if (typeof input.num === "number") args.push("--num", String(input.num));
        if (input.text) args.push("--text");
        if (input.highlights) args.push("--highlights");
        if (input.category) args.push("--category", String(input.category));
        const result = await execCommand(process.execPath, args, 30_000, { EXA_API_KEY: apiKey });
        if (result.code !== 0 && result.stderr) {
          return { result: `Error (exit ${result.code}): ${result.stderr.trim()}\n${result.stdout.trim()}`.trim() };
        }
        return { result: result.stdout.trim() };
      },
    },

    {
      name: "exa_answer",
      description: [
        "Get a quick factual answer from the web using EXA's answer API.",
        "Returns a synthesized answer with citations. Best for factual queries.",
        "Cost: ~$0.005 per query.",
        "Use for: Quick facts, current info, price checks, availability.",
        "NOT for: Deep research (use exa_search with multiple queries instead).",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string", description: "Factual question to answer" },
        },
        required: ["question"],
      },
      handler: async (input) => {
        const apiKey = await getExaKey();
        const result = await execCommand(
          process.execPath,
          [paths.exaAnswerScript, String(input.question)],
          30_000,
          { EXA_API_KEY: apiKey },
        );
        if (result.code !== 0 && result.stderr) {
          return { result: `Error (exit ${result.code}): ${result.stderr.trim()}\n${result.stdout.trim()}`.trim() };
        }
        return { result: result.stdout.trim() };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// 3D Printing tools
// ---------------------------------------------------------------------------

export function createPrintingTools(overrides?: ResearchToolPaths): AgentTool[] {
  const paths = resolvePaths(overrides);

  return [
    {
      name: "printer_command",
      description: [
        "Prusa MK4 3D printer management via PrusaLink REST API.",
        "Printer endpoint: configurable via ResearchToolPaths.prusaPrinterIp or local overrides.",
        "Build volume: 250x210x220mm | Nozzle: 0.4mm",
        "",
        "Actions:",
        "  status — Get printer state (IDLE, PRINTING, FINISHED, PAUSED, ERROR)",
        "  job — Get current print job progress (percentage, time remaining)",
        "  upload — Upload a .gcode file to the printer",
        "  start — Start printing an uploaded file (use 8.3 filename from upload response)",
        "  stop — Stop current print job",
        "",
        "Safety:",
        "  dry_run=true previews upload/start/stop without changing the printer.",
        "",
        "File locations: configurable printing workspace (profile project dir by default).",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["status", "job", "upload", "start", "stop"],
            description: "Printer action to perform",
          },
          file_path: {
            type: "string",
            description: "For upload: local path to .gcode file. For start: 8.3 filename on printer.",
          },
          job_id: {
            type: "string",
            description: "For stop: job ID to cancel.",
          },
          dry_run: {
            type: "boolean",
            description: "Preview upload/start/stop without changing the printer.",
          },
        },
        required: ["action"],
      },
      handler: async (input) => {
        const action = String(input.action);
        const ip = paths.prusaPrinterIp;
        const dryRun = input.dry_run === true;
        if (dryRun && (action === "upload" || action === "start" || action === "stop")) {
          return {
            dry_run: true,
            action,
            preview: action === "upload"
              ? `Would upload ${String(input.file_path)} to printer ${ip}`
              : action === "start"
                ? `Would start printer file ${String(input.file_path)} on printer ${ip}`
                : `Would stop printer job ${String(input.job_id)} on printer ${ip}`,
          };
        }

        const apiKey = paths.prusaApiKey ?? await resolvePrusaApiKey();
        const baseUrl = `http://${ip}/api/v1`;
        const headers: Record<string, string> = { "X-Api-Key": apiKey };

        /** Safely parse JSON from a fetch response, returning an error object on failure. */
        const safeJson = async (res: Response): Promise<unknown> => {
          const text = await res.text();
          if (!text) return { error: `HTTP ${res.status}: empty response body` };
          try { return JSON.parse(text); }
          catch { return { error: `HTTP ${res.status}: invalid JSON — ${text.slice(0, 200)}` }; }
        };

        try {
          switch (action) {
            case "status": {
              const res = await fetch(`${baseUrl}/status`, { headers });
              return res.ok ? await safeJson(res) : { error: `HTTP ${res.status}` };
            }
            case "job": {
              const res = await fetch(`${baseUrl}/job`, { headers });
              return res.ok ? await safeJson(res) : { error: `HTTP ${res.status}` };
            }
            case "upload": {
              const filePath = String(input.file_path);
              const data = fs.readFileSync(filePath);
              const filename = path.basename(filePath);
              const res = await fetch(`${baseUrl}/files/usb/${filename}`, {
                method: "PUT",
                headers: { ...headers, "Content-Type": "application/octet-stream", "Overwrite": "?1" },
                body: data,
              });
              return res.ok ? await safeJson(res) : { error: `HTTP ${res.status}: ${await res.text()}` };
            }
            case "start": {
              const filename = String(input.file_path);
              const res = await fetch(`${baseUrl}/files/usb/${filename}`, {
                method: "POST",
                headers,
              });
              return res.ok ? { success: true, message: `Print started: ${filename}` } : { error: `HTTP ${res.status}` };
            }
            case "stop": {
              const jobId = String(input.job_id);
              const res = await fetch(`${baseUrl}/job/${jobId}`, {
                method: "DELETE",
                headers,
              });
              return res.ok ? { success: true, message: "Print stopped" } : { error: `HTTP ${res.status}` };
            }
            default:
              return { error: `Unknown action: ${action}` };
          }
        } catch (err) {
          return { error: `printer_command failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },

    {
      name: "openscad_render",
      description: [
        "Render an OpenSCAD .scad file to .stl.",
        "OpenSCAD CLI path is configurable via local overrides or environment.",
        "",
        "Parameters can be overridden with -D flags (e.g. gridx=3, gridy=2).",
        "Output goes to the configured printing workspace by default.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          input_file: { type: "string", description: "Path to .scad source file" },
          output_file: { type: "string", description: "Path for .stl output" },
          parameters: {
            type: "object",
            description: "OpenSCAD parameter overrides (e.g. {\"gridx\": 3, \"gridy\": 2})",
          },
        },
        required: ["input_file", "output_file"],
      },
      handler: async (input) => {
        const args: string[] = ["-o", String(input.output_file)];
        if (input.parameters && typeof input.parameters === "object") {
          for (const [key, value] of Object.entries(input.parameters as Record<string, unknown>)) {
            args.push("-D", `${key}=${value}`);
          }
        }
        args.push(String(input.input_file));
        const stdout = await runCommand(paths.openscadCommand, args, 120_000);
        return { success: true, output: String(input.output_file), log: stdout };
      },
    },

    {
      name: "prusa_slice",
      description: [
        "Slice an .stl file to .gcode using PrusaSlicer CLI.",
        "",
        "Print profiles: '0.10mm FAST DETAIL', '0.15mm SPEED', '0.20mm SPEED' (fastest), '0.20mm STRUCTURAL'",
        "Materials: 'Generic PLA @PGIS', 'Generic PETG @PGIS', 'Prusament PLA @PGIS'",
        "Tip: 5% infill for organizers/holders — 15% default wastes hours for no benefit.",
        "",
        "IMPORTANT: After slicing, comments must be truncated to prevent MK4 buffer overflow.",
        "This tool handles the truncation automatically.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          input_file: { type: "string", description: "Path to .stl file" },
          output_file: { type: "string", description: "Path for .gcode output" },
          print_profile: {
            type: "string",
            description: "Print profile (default: '0.20mm SPEED @MK4IS 0.4')",
          },
          material_profile: {
            type: "string",
            description: "Material profile (default: 'Generic PLA @PGIS')",
          },
          infill: {
            type: "number",
            description: "Infill percentage (default: 15, use 5 for organizers)",
          },
        },
        required: ["input_file", "output_file"],
      },
      handler: async (input) => {
        const printProfile = String(input.print_profile ?? "0.20mm SPEED @MK4IS 0.4");
        const materialProfile = String(input.material_profile ?? "Generic PLA @PGIS");
        const args: string[] = [
          "-g", String(input.input_file),
          "--printer-profile", "Original Prusa MK4 Input Shaper 0.4 nozzle",
          "--print-profile", printProfile,
          "--material-profile", materialProfile,
          "--binary-gcode=0",
          "-o", String(input.output_file),
        ];

        if (typeof input.infill === "number") {
          args.push("--fill-density", `${input.infill}%`);
        }

        const stdout = await runCommand(paths.prusaSlicerCommand, args, 120_000);

        // Truncate long comment lines to prevent MK4 buffer overflow
        const gcodeFile = String(input.output_file);
        if (fs.existsSync(gcodeFile)) {
          await runCommand("sed", ["-i", "", "s/^\\(.\\{250\\}\\).*/\\1/", gcodeFile], 10_000);
        }

        return { success: true, output: gcodeFile, log: stdout };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Paper document printing tools
// ---------------------------------------------------------------------------

const PAPER_TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".csv", ".log"]);
const PAPER_TEXTUTIL_EXTENSIONS = new Set([".html", ".htm", ".rtf", ".doc", ".docx"]);
const PAPER_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".tif", ".tiff", ".gif", ".bmp"]);
const PAPER_SIDES = new Set(["one-sided", "two-sided-long-edge", "two-sided-short-edge"]);
const PAPER_WRAP_COLUMNS = 70;

interface PaperPreparedPdf {
  pdfPath: string;
  pageCount?: number;
  bytes: number;
  sourceType: "content" | "pdf" | "converted";
  intermediateTextPath?: string;
  warnings: string[];
}

interface PaperPrinterList {
  defaultPrinter: string | null;
  printers: Array<{
    name: string;
    enabled: boolean;
    status: string;
    raw: string;
  }>;
  warnings: string[];
}

function expandHomePath(value: string, home = os.homedir()): string {
  return value === "~" ? home : value.replace(/^~(?=\/)/u, home);
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function safePaperSlug(value: string | undefined): string {
  const normalized = (value ?? "paper-document")
    .normalize("NFKD")
    .replace(/[^\w\s.-]/gu, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
  return normalized || "paper-document";
}

function timestampForFilename(date = new Date()): string {
  return date.toISOString().replace(/[:.]/gu, "-");
}

function normalizeCopies(value: unknown): number {
  const copies = Number(value ?? 1);
  if (!Number.isFinite(copies)) return 1;
  return Math.min(99, Math.max(1, Math.trunc(copies)));
}

function assertAllowedPath(kind: "source" | "output", candidate: string, roots: string[]): void {
  if (!roots.some((root) => isPathInside(root, candidate))) {
    const displayRoots = roots.map((root) => root.replace(os.homedir(), "~")).join(", ");
    throw new Error(`${kind} path is outside allowed roots. Allowed: ${displayRoots}`);
  }
}

function paperSourceRoots(paths: ReturnType<typeof resolvePaths>): string[] {
  const home = os.homedir();
  return [
    os.tmpdir(),
    "/tmp",
    path.join(home, "Downloads"),
    path.join(home, "Documents"),
    paths.paperPrintDir,
  ];
}

function paperOutputRoots(paths: ReturnType<typeof resolvePaths>): string[] {
  const home = os.homedir();
  return [
    paths.paperPrintDir,
    path.join(home, "Downloads"),
    path.join(home, "Documents"),
  ];
}

function resolvePaperSourcePath(paths: ReturnType<typeof resolvePaths>, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("source_file is required when content is not provided");
  }
  const resolved = path.resolve(expandHomePath(value.trim()));
  if (!fs.existsSync(resolved)) {
    throw new Error(`source_file does not exist: ${value}`);
  }
  if (!fs.statSync(resolved).isFile()) {
    throw new Error(`source_file is not a file: ${value}`);
  }
  assertAllowedPath("source", resolved, paperSourceRoots(paths));
  return resolved;
}

function resolvePaperOutputPath(
  paths: ReturnType<typeof resolvePaths>,
  outputFile: unknown,
  title: string | undefined,
): string {
  const defaultName = `${safePaperSlug(title)}-${timestampForFilename()}.pdf`;
  const outputPath = typeof outputFile === "string" && outputFile.trim().length > 0
    ? path.resolve(expandHomePath(outputFile.trim()))
    : path.join(paths.paperPrintDir, defaultName);
  const normalizedOutput = path.extname(outputPath).toLowerCase() === ".pdf"
    ? outputPath
    : `${outputPath}.pdf`;
  assertAllowedPath("output", normalizedOutput, paperOutputRoots(paths));
  fs.mkdirSync(path.dirname(normalizedOutput), { recursive: true });
  return normalizedOutput;
}

function buildPaperText(content: string, title: string | undefined): string {
  const trimmedTitle = title?.trim();
  const normalizedContent = wrapPaperText(content.replace(/\s+$/u, ""));
  if (!trimmedTitle) {
    return `${normalizedContent}\n`;
  }
  const underline = "=".repeat(Math.min(80, Math.max(8, trimmedTitle.length)));
  return `${trimmedTitle}\n${underline}\n\n${normalizedContent}\n`;
}

function wrapPaperText(content: string): string {
  return content
    .split(/\r?\n/u)
    .flatMap((line) => wrapPaperLine(line))
    .join("\n");
}

function wrapPaperLine(line: string): string[] {
  if (line.length <= PAPER_WRAP_COLUMNS || line.trim().length === 0) {
    return [line];
  }

  const bulletMatch = line.match(/^(\s*[-*]\s+)(.*)$/u);
  const prefix = bulletMatch?.[1] ?? "";
  const text = bulletMatch?.[2] ?? line.trim();
  const continuationPrefix = prefix ? " ".repeat(prefix.length) : "";
  const words = text.split(/\s+/u);
  const lines: string[] = [];
  let current = prefix;

  for (const word of words) {
    const candidate = current.trimEnd().length === 0 ? `${current}${word}` : `${current} ${word}`;
    if (candidate.length <= PAPER_WRAP_COLUMNS) {
      current = candidate;
      continue;
    }
    if (current.trim().length > 0) {
      lines.push(current.trimEnd());
    }
    current = `${lines.length > 0 ? continuationPrefix : prefix}${word}`;
  }

  if (current.trim().length > 0) {
    lines.push(current.trimEnd());
  }
  return lines.length > 0 ? lines : [line];
}

async function writeCupsfilterPdf(
  paths: ReturnType<typeof resolvePaths>,
  inputFile: string,
  outputFile: string,
): Promise<string[]> {
  const result = await execCommandBuffer(
    paths.cupsfilterCommand,
    ["-m", "application/pdf", inputFile],
    120_000,
  );
  if (result.code !== 0 || result.stdout.length === 0) {
    const detail = result.stderr.trim() || `exit ${result.code}`;
    throw new Error(`cupsfilter failed to create PDF: ${detail}`);
  }
  fs.writeFileSync(outputFile, result.stdout);
  const usefulStderr = result.stderr
    .split(/\r?\n/u)
    .filter((line) => /^ERROR:/iu.test(line) || /^WARNING:/iu.test(line))
    .slice(0, 5);
  return usefulStderr;
}

async function maybeConvertSourceToText(
  paths: ReturnType<typeof resolvePaths>,
  sourceFile: string,
  outputPdf: string,
  warnings: string[],
): Promise<string | null> {
  const extension = path.extname(sourceFile).toLowerCase();
  if (!PAPER_TEXTUTIL_EXTENSIONS.has(extension)) {
    return null;
  }

  const textOutput = outputPdf.replace(/\.pdf$/iu, ".source.txt");
  const result = await execCommand(paths.textutilCommand, ["-convert", "txt", "-stdout", sourceFile], 60_000);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
    warnings.push(`textutil conversion failed; attempting cupsfilter directly: ${detail}`);
    return null;
  }
  fs.writeFileSync(textOutput, `${wrapPaperText(result.stdout.trimEnd())}\n`, "utf8");
  return textOutput;
}

function writeWrappedPaperTextSource(sourceFile: string, outputPdf: string): string {
  const textOutput = outputPdf.replace(/\.pdf$/iu, ".source.txt");
  const content = fs.readFileSync(sourceFile, "utf8").replace(/\s+$/u, "");
  fs.writeFileSync(textOutput, `${wrapPaperText(content)}\n`, "utf8");
  return textOutput;
}

async function inspectPaperPdf(
  paths: ReturnType<typeof resolvePaths>,
  pdfPath: string,
  warnings: string[],
): Promise<{ pageCount?: number; bytes: number }> {
  const stat = fs.statSync(pdfPath);
  try {
    const result = await execCommand(paths.pdfinfoCommand, [pdfPath], 10_000);
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
      warnings.push(`pdfinfo failed: ${detail}`);
      return { bytes: stat.size };
    }
    const pageMatch = result.stdout.match(/^Pages:\s+(\d+)/mu);
    return {
      bytes: stat.size,
      ...(pageMatch ? { pageCount: Number(pageMatch[1]) } : {}),
    };
  } catch (error) {
    warnings.push(`pdfinfo unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return { bytes: stat.size };
  }
}

async function preparePaperPdf(
  paths: ReturnType<typeof resolvePaths>,
  input: Record<string, unknown>,
): Promise<PaperPreparedPdf> {
  const content = typeof input.content === "string" && input.content.trim().length > 0
    ? input.content
    : null;
  const hasSource = typeof input.source_file === "string" && input.source_file.trim().length > 0;
  if (!content && !hasSource) {
    throw new Error("preview/print requires either content or source_file");
  }
  if (content && hasSource) {
    throw new Error("Provide either content or source_file, not both");
  }

  const title = typeof input.title === "string" && input.title.trim().length > 0
    ? input.title.trim()
    : undefined;
  const outputPdf = resolvePaperOutputPath(paths, input.output_file, title);
  const warnings: string[] = [];

  if (content) {
    const textPath = outputPdf.replace(/\.pdf$/iu, ".txt");
    fs.writeFileSync(textPath, buildPaperText(content, title), "utf8");
    warnings.push(...await writeCupsfilterPdf(paths, textPath, outputPdf));
    const inspection = await inspectPaperPdf(paths, outputPdf, warnings);
    return {
      pdfPath: outputPdf,
      pageCount: inspection.pageCount,
      bytes: inspection.bytes,
      sourceType: "content",
      intermediateTextPath: textPath,
      warnings,
    };
  }

  const sourceFile = resolvePaperSourcePath(paths, input.source_file);
  const extension = path.extname(sourceFile).toLowerCase();
  if (extension === ".pdf") {
    if (path.resolve(sourceFile) !== path.resolve(outputPdf)) {
      fs.copyFileSync(sourceFile, outputPdf);
    }
    const inspection = await inspectPaperPdf(paths, outputPdf, warnings);
    return {
      pdfPath: outputPdf,
      pageCount: inspection.pageCount,
      bytes: inspection.bytes,
      sourceType: "pdf",
      warnings,
    };
  }

  let conversionSource = sourceFile;
  let intermediateTextPath: string | null = null;
  if (PAPER_TEXT_EXTENSIONS.has(extension)) {
    intermediateTextPath = writeWrappedPaperTextSource(sourceFile, outputPdf);
    conversionSource = intermediateTextPath;
  } else {
    intermediateTextPath = await maybeConvertSourceToText(paths, sourceFile, outputPdf, warnings);
  }
  if (intermediateTextPath) {
    conversionSource = intermediateTextPath;
  }
  const supportedDirect = PAPER_TEXT_EXTENSIONS.has(extension) || PAPER_IMAGE_EXTENSIONS.has(extension) || intermediateTextPath;
  if (!supportedDirect) {
    warnings.push(`Attempting generic CUPS conversion for ${extension || "extensionless"} source.`);
  }
  warnings.push(...await writeCupsfilterPdf(paths, conversionSource, outputPdf));
  const inspection = await inspectPaperPdf(paths, outputPdf, warnings);
  return {
    pdfPath: outputPdf,
    pageCount: inspection.pageCount,
    bytes: inspection.bytes,
    sourceType: "converted",
    ...(intermediateTextPath ? { intermediateTextPath } : {}),
    warnings,
  };
}

async function listPaperPrinters(paths: ReturnType<typeof resolvePaths>): Promise<PaperPrinterList> {
  const warnings: string[] = [];
  let defaultPrinter: string | null = null;
  const defaultResult = await execCommand(paths.lpstatCommand, ["-d"], 10_000);
  if (defaultResult.code === 0) {
    const defaultMatch = defaultResult.stdout.match(/(?:system )?default destination:\s*(.+)$/imu);
    defaultPrinter = defaultMatch?.[1]?.trim() || null;
  } else if (!/no system default destination/iu.test(defaultResult.stderr + defaultResult.stdout)) {
    warnings.push(`lpstat -d failed: ${(defaultResult.stderr || defaultResult.stdout).trim()}`);
  }

  const printersResult = await execCommand(paths.lpstatCommand, ["-p"], 10_000);
  const printers: PaperPrinterList["printers"] = [];
  if (printersResult.code === 0) {
    for (const line of printersResult.stdout.split(/\r?\n/u)) {
      const match = line.match(/^printer\s+(\S+)\s+(.+)$/iu);
      if (!match) continue;
      const status = match[2]!.trim();
      printers.push({
        name: match[1]!,
        enabled: !/\bdisabled\b/iu.test(status),
        status,
        raw: line,
      });
    }
  } else if (!/No destinations added/iu.test(printersResult.stderr + printersResult.stdout)) {
    warnings.push(`lpstat -p failed: ${(printersResult.stderr || printersResult.stdout).trim()}`);
  }

  return { defaultPrinter, printers, warnings };
}

function buildLpArgs(input: Record<string, unknown>, pdfPath: string, destination: string | null): string[] {
  const args: string[] = [];
  if (destination) {
    args.push("-d", destination);
  }
  args.push("-n", String(normalizeCopies(input.copies)));
  if (typeof input.title === "string" && input.title.trim().length > 0) {
    args.push("-t", input.title.trim());
  }
  if (typeof input.sides === "string" && input.sides.trim().length > 0) {
    const sides = input.sides.trim();
    if (!PAPER_SIDES.has(sides)) {
      throw new Error(`Unsupported sides value: ${sides}`);
    }
    args.push("-o", `sides=${sides}`);
  }
  if (typeof input.media === "string" && input.media.trim().length > 0) {
    args.push("-o", `media=${input.media.trim()}`);
  }
  args.push(pdfPath);
  return args;
}

export function createPaperPrintingTools(overrides?: ResearchToolPaths): AgentTool[] {
  const paths = resolvePaths(overrides);

  return [
    {
      name: "paper_print",
      description: [
        "Create previewable PDFs for paper documents and send PDFs to the local macOS CUPS print queue.",
        "",
        "Actions:",
        "  list_printers - list configured CUPS printer destinations and the default destination.",
        "  preview - create a stable PDF from content or a local source_file; does not print.",
        "  print - create/copy the PDF and print it. dry_run defaults to true; set dry_run=false only when the user explicitly asked for physical printing.",
        "",
        "Inputs:",
        "  source_file: local PDF/text/Markdown/CSV/HTML/RTF/DOC/DOCX/image path under /tmp, ~/Downloads, ~/Documents, or the paper print output dir.",
        "  content: plain text or Markdown-ish content to render as a text PDF.",
        "  output_file: optional PDF path under the paper print output dir, ~/Downloads, or ~/Documents.",
        "  printer: optional CUPS printer destination. If omitted, the system default destination is used.",
        "  copies: copy count, default 1. sides: one-sided, two-sided-long-edge, or two-sided-short-edge.",
        "",
        "Use preview first for travel confirmations. Never claim a physical print succeeded unless this tool returns a print job from lp.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list_printers", "preview", "print"],
            description: "Paper printing action.",
          },
          source_file: {
            type: "string",
            description: "Local source file path to preview/print. Use for downloaded email attachments or existing PDFs.",
          },
          content: {
            type: "string",
            description: "Plain text or Markdown-ish content to render as a text PDF.",
          },
          output_file: {
            type: "string",
            description: "Optional output PDF path under allowed output directories.",
          },
          title: {
            type: "string",
            description: "Document/job title used for generated filenames and lp job title.",
          },
          printer: {
            type: "string",
            description: "Optional CUPS printer destination name.",
          },
          copies: {
            type: "number",
            description: "Number of copies to print. Default 1.",
          },
          sides: {
            type: "string",
            enum: ["one-sided", "two-sided-long-edge", "two-sided-short-edge"],
            description: "CUPS sides option. Default uses printer settings.",
          },
          media: {
            type: "string",
            description: "Optional CUPS media option such as Letter.",
          },
          dry_run: {
            type: "boolean",
            description: "For print action, defaults to true. Set false only to send a real print job.",
          },
        },
        required: ["action"],
      },
      handler: async (input) => {
        try {
          const action = String(input.action ?? "").trim();
          if (action === "list_printers") {
            return await listPaperPrinters(paths);
          }
          if (action !== "preview" && action !== "print") {
            return { error: `Unknown action: ${action}` };
          }

          const prepared = await preparePaperPdf(paths, input);
          if (action === "preview") {
            return {
              success: true,
              action,
              pdf_path: prepared.pdfPath,
              page_count: prepared.pageCount,
              bytes: prepared.bytes,
              source_type: prepared.sourceType,
              intermediate_text_path: prepared.intermediateTextPath,
              warnings: prepared.warnings,
            };
          }

          const dryRun = input.dry_run !== false;
          const printers = await listPaperPrinters(paths);
          const requestedPrinter = typeof input.printer === "string" && input.printer.trim().length > 0
            ? input.printer.trim()
            : null;
          const destination = requestedPrinter ?? printers.defaultPrinter;
          const lpArgs = buildLpArgs(input, prepared.pdfPath, destination);

          if (dryRun) {
            return {
              dry_run: true,
              action,
              pdf_path: prepared.pdfPath,
              page_count: prepared.pageCount,
              bytes: prepared.bytes,
              printer: destination,
              copies: normalizeCopies(input.copies),
              lp_command_preview: [paths.lpCommand, ...lpArgs],
              printers,
              warnings: prepared.warnings,
            };
          }

          if (!destination) {
            return {
              error: "No CUPS printer destination is configured. Add a printer in macOS System Settings or pass a configured printer name.",
              pdf_path: prepared.pdfPath,
              printers,
              warnings: prepared.warnings,
            };
          }

          const result = await execCommand(paths.lpCommand, lpArgs, 60_000);
          if (result.code !== 0) {
            return {
              error: `lp failed: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`,
              pdf_path: prepared.pdfPath,
              printer: destination,
              warnings: prepared.warnings,
            };
          }

          return {
            success: true,
            action,
            pdf_path: prepared.pdfPath,
            page_count: prepared.pageCount,
            bytes: prepared.bytes,
            printer: destination,
            copies: normalizeCopies(input.copies),
            lp_output: result.stdout.trim(),
            warnings: prepared.warnings,
          };
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Travel tools (location + diesel finder)
// ---------------------------------------------------------------------------

export function createTravelTools(): AgentTool[] {
  const profileLocationFile = path.join(resolveTangoProfileDataDir(), "location", "latest.json");
  const configuredLocationFile = process.env.TANGO_LOCATION_FILE?.trim();
  const locationFile = configuredLocationFile && configuredLocationFile.length > 0
    ? resolveConfiguredPath(configuredLocationFile)
    : profileLocationFile;
  const dieselScript = path.join(process.cwd(), "scripts/find-diesel.js");
  const geocodeCache = new Map<string, Promise<ResolvedRoutePoint>>();

  interface ResolvedRoutePoint {
    input: string;
    lat: number;
    lon: number;
    displayName?: string;
    source: "coordinate" | "current_location" | "nominatim" | "here-discover" | "here-geocode";
    ageSec?: number | null;
  }

  interface RouteOption {
    label?: string;
    origin?: unknown;
    destination?: unknown;
    waypoints?: unknown;
  }

  type RouteMode = "driving" | "walking";

  interface RouteResult {
    label: string;
    mode: RouteMode;
    source: "here" | "osrm";
    distanceMiles: number;
    durationHours: number;
    durationText: string;
    durationBasis: string;
    baseDurationHours?: number;
    via?: Array<{ road: string; miles: number }>;
    passesThrough?: string[];
    resolvedPoints: ResolvedRoutePoint[];
    googleMapsUrl: string;
    osrmUrl?: string;
    warning?: string;
    hereError?: string;
  }

  const readCurrentPosition = (): { lat: number; lon: number; ageSec: number | null } => {
    const raw = fs.readFileSync(locationFile, "utf-8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (typeof data.lat !== "number" || typeof data.lon !== "number") {
      throw new Error("latest location is missing lat/lon");
    }
    const ageSec = typeof data.timestamp === "number"
      ? Math.round(Date.now() / 1000 - data.timestamp)
      : null;
    return { lat: data.lat, lon: data.lon, ageSec };
  };

  const parseCoordinate = (value: string): { lat: number; lon: number } | null => {
    const match = value.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/u);
    if (!match) return null;
    const lat = Number(match[1]);
    const lon = Number(match[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon };
  };

  const hereApiKey = process.env.HERE_API_KEY?.trim() || null;

  const tryReadCurrentPosition = (): { lat: number; lon: number } | null => {
    try {
      const current = readCurrentPosition();
      return { lat: current.lat, lon: current.lon };
    } catch {
      return null;
    }
  };

  interface HereNamedItem {
    id?: string;
    name?: string;
    primary?: boolean;
  }

  interface HereContactValue {
    value?: string;
  }

  interface HereContact {
    phone?: HereContactValue[];
    mobile?: HereContactValue[];
    tollFree?: HereContactValue[];
    www?: HereContactValue[];
    email?: HereContactValue[];
  }

  interface HereOpeningHour {
    text?: string[];
    isOpen?: boolean;
  }

  interface HereSearchItem {
    id?: string;
    resultType?: string;
    position?: { lat?: number; lng?: number };
    address?: { label?: string; city?: string; stateCode?: string; countryCode?: string };
    title?: string;
    distance?: number;
    categories?: HereNamedItem[];
    foodTypes?: HereNamedItem[];
    contacts?: HereContact[];
    openingHours?: HereOpeningHour[];
  }

  const parseHereItem = (
    value: string,
    item: HereSearchItem | undefined,
    source: "here-discover" | "here-geocode",
  ): ResolvedRoutePoint | null => {
    const lat = item?.position?.lat;
    const lon = item?.position?.lng;
    if (typeof lat !== "number" || typeof lon !== "number") return null;
    const displayName = item?.address?.label ?? item?.title;
    return { input: value, lat, lon, source, ...(displayName ? { displayName } : {}) };
  };

  const geocodeViaHere = async (value: string): Promise<ResolvedRoutePoint | null> => {
    if (!hereApiKey) return null;
    // Discover resolves POI queries ("Costco, Fairview, SC") that Nominatim
    // misses when the named city differs from the postal city. Anchor at
    // current GPS when available so bare POI names resolve to the nearest one.
    const anchor = tryReadCurrentPosition() ?? { lat: 39.8283, lon: -98.5795 };
    const discoverUrl = `https://discover.search.hereapi.com/v1/discover?at=${anchor.lat},${anchor.lon}&q=${encodeURIComponent(value)}&limit=1&apiKey=${hereApiKey}`;
    const discoverResponse = await fetch(discoverUrl);
    if (discoverResponse.ok) {
      const data = await discoverResponse.json() as { items?: HereSearchItem[] };
      const resolved = parseHereItem(value, data.items?.[0], "here-discover");
      if (resolved) return resolved;
    }
    const geocodeUrl = `https://geocode.search.hereapi.com/v1/geocode?q=${encodeURIComponent(value)}&apiKey=${hereApiKey}`;
    const geocodeResponse = await fetch(geocodeUrl);
    if (geocodeResponse.ok) {
      const data = await geocodeResponse.json() as { items?: HereSearchItem[] };
      return parseHereItem(value, data.items?.[0], "here-geocode");
    }
    return null;
  };

  const collectHereNamedValues = (values: HereNamedItem[] | undefined): string[] => {
    const seen = new Set<string>();
    const output: string[] = [];
    for (const entry of [...(values ?? [])].sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)))) {
      const value = entry.name?.trim();
      if (!value || seen.has(value.toLocaleLowerCase())) continue;
      seen.add(value.toLocaleLowerCase());
      output.push(value);
    }
    return output;
  };

  const collectHereContactValues = (
    contacts: HereContact[] | undefined,
    field: keyof HereContact,
  ): string[] => {
    const seen = new Set<string>();
    const output: string[] = [];
    for (const contact of contacts ?? []) {
      for (const entry of contact[field] ?? []) {
        const value = entry.value?.trim();
        if (!value || seen.has(value.toLocaleLowerCase())) continue;
        seen.add(value.toLocaleLowerCase());
        output.push(value);
      }
    }
    return output;
  };

  const normalizeWebsite = (value: string): string => (
    /^https?:\/\//iu.test(value) ? value : `https://${value}`
  );

  const buildGoogleMapsSearchUrl = (item: HereSearchItem): string => {
    const queryParts = [
      item.title,
      item.address?.label,
      typeof item.position?.lat === "number" && typeof item.position?.lng === "number"
        ? `${item.position.lat},${item.position.lng}`
        : null,
    ].filter((part): part is string => typeof part === "string" && part.trim().length > 0);
    return `https://www.google.com/maps/search/?${new URLSearchParams({
      api: "1",
      query: queryParts.join(" "),
    }).toString()}`;
  };

  const parseLocalBusinessItem = (item: HereSearchItem): Record<string, unknown> | null => {
    const lat = item.position?.lat;
    const lon = item.position?.lng;
    if (!item.title || typeof lat !== "number" || typeof lon !== "number") {
      return null;
    }

    const websites = collectHereContactValues(item.contacts, "www").map(normalizeWebsite);
    const openingHours = [...new Set((item.openingHours ?? []).flatMap((hours) => hours.text ?? []))];
    const isOpenValues = (item.openingHours ?? [])
      .map((hours) => hours.isOpen)
      .filter((value): value is boolean => typeof value === "boolean");

    return {
      name: item.title,
      resultType: item.resultType,
      address: item.address?.label,
      position: { lat, lon },
      ...(typeof item.distance === "number"
        ? { distanceMiles: Number((item.distance / 1609.34).toFixed(2)) }
        : {}),
      categories: collectHereNamedValues(item.categories),
      foodTypes: collectHereNamedValues(item.foodTypes),
      phoneNumbers: [
        ...collectHereContactValues(item.contacts, "phone"),
        ...collectHereContactValues(item.contacts, "mobile"),
        ...collectHereContactValues(item.contacts, "tollFree"),
      ],
      websites,
      emails: collectHereContactValues(item.contacts, "email"),
      openingHours,
      ...(isOpenValues.length > 0 ? { isOpen: isOpenValues[0] } : {}),
      hereId: item.id,
      googleMapsSearchUrl: buildGoogleMapsSearchUrl(item),
    };
  };

  const normalizeLimit = (value: unknown): number => {
    const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(parsed)) return 12;
    return Math.max(1, Math.min(25, Math.trunc(parsed)));
  };

  const normalizeRadiusMeters = (value: unknown): number => {
    const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(parsed)) return 12_000;
    return Math.max(500, Math.min(50_000, Math.trunc(parsed)));
  };

  const normalizeStringArray = (value: unknown): string[] => {
    if (Array.isArray(value)) {
      return value.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0);
    }
    if (typeof value === "string" && value.trim().length > 0) {
      return value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
    }
    return [];
  };

  const handleLocalBusinessSearch = async (input: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const query = String(input.query ?? "").trim();
    if (!query) {
      return { error: "local_business_search requires a non-empty query." };
    }
    if (!hereApiKey) {
      return { error: "HERE_API_KEY not configured; local business candidate search is unavailable." };
    }

    try {
      const nearInput = typeof input.near === "string" && input.near.trim().length > 0
        ? input.near.trim()
        : "current location";
      const anchor = await resolvePlace(nearInput);
      const limit = normalizeLimit(input.limit);
      const radiusMeters = normalizeRadiusMeters(input.radius_meters);
      const categories = normalizeStringArray(input.categories);
      const params = new URLSearchParams({
        q: query,
        limit: String(limit),
        lang: "en-US",
        in: `circle:${anchor.lat},${anchor.lon};r=${radiusMeters}`,
        apiKey: hereApiKey,
      });
      if (categories.length > 0) {
        params.set("categories", categories.join(","));
      }

      const url = `https://discover.search.hereapi.com/v1/discover?${params.toString()}`;
      const response = await fetch(url);
      if (!response.ok) {
        return { error: `HERE Discover failed: HTTP ${response.status}` };
      }

      const data = await response.json() as { items?: HereSearchItem[] };
      const results = (data.items ?? [])
        .map(parseLocalBusinessItem)
        .filter((item): item is Record<string, unknown> => item !== null);
      const warnings: string[] = [];
      if (results.length === 0) {
        warnings.push("No HERE Discover candidates returned for this query and radius.");
      }
      if (anchor.source === "current_location" && typeof anchor.ageSec === "number" && anchor.ageSec > 3600) {
        warnings.push("Current location is stale; confirm the area before relying on nearby results.");
      }

      return {
        source: "here-discover",
        searchedAt: new Date().toISOString(),
        query,
        near: {
          input: anchor.input,
          displayName: anchor.displayName,
          lat: anchor.lat,
          lon: anchor.lon,
          source: anchor.source,
          ageSec: anchor.ageSec,
        },
        radiusMeters,
        resultCount: results.length,
        results,
        warnings,
      };
    } catch (err: unknown) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };

  const resolvePlace = async (input: unknown): Promise<ResolvedRoutePoint> => {
    const value = String(input ?? "").trim();
    if (value.length === 0 || /^(current( location)?|here|gps)$/iu.test(value)) {
      const current = readCurrentPosition();
      return { input: value || "current location", ...current, source: "current_location" };
    }

    const coordinate = parseCoordinate(value);
    if (coordinate) {
      return { input: value, ...coordinate, source: "coordinate" };
    }

    const cacheKey = value.toLocaleLowerCase();
    let geocode = geocodeCache.get(cacheKey);
    if (!geocode) {
      geocode = (async () => {
        const nominatimResult = await (async (): Promise<ResolvedRoutePoint | null> => {
          const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(value)}&format=json&limit=1`;
          const response = await fetch(url, { headers: { "User-Agent": "tango-osrm-route/1.0" } });
          if (!response.ok) return null;
          const results = await response.json() as Array<Record<string, unknown>>;
          const first = results[0];
          const lat = Number(first?.lat);
          const lon = Number(first?.lon);
          if (!first || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
          return {
            input: value,
            lat,
            lon,
            source: "nominatim" as const,
            ...(typeof first.display_name === "string" ? { displayName: first.display_name } : {}),
          };
        })().catch(() => null);
        if (nominatimResult) return nominatimResult;

        const hereResult = await geocodeViaHere(value).catch(() => null);
        if (hereResult) return hereResult;

        throw new Error(`could not geocode "${value}"`);
      })();
      geocodeCache.set(cacheKey, geocode);
    }
    try {
      return await geocode;
    } catch (err) {
      geocodeCache.delete(cacheKey);
      throw err;
    }
  };

  const buildGoogleMapsUrl = (
    points: Array<{ lat: number; lon: number }>,
    mode: RouteMode,
  ): string => {
    const origin = points[0]!;
    const destination = points[points.length - 1]!;
    const waypoints = points.slice(1, -1);
    const params = new URLSearchParams({
      api: "1",
      origin: `${origin.lat},${origin.lon}`,
      destination: `${destination.lat},${destination.lon}`,
      travelmode: mode,
    });
    if (waypoints.length > 0) {
      params.set("waypoints", waypoints.map((point) => `${point.lat},${point.lon}`).join("|"));
    }
    return `https://www.google.com/maps/dir/?${params.toString()}`;
  };

  const formatDuration = (hours: number): string => {
    const totalMinutes = Math.round(hours * 60);
    const wholeHours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${wholeHours}h ${minutes}m`;
  };

  // HERE encodes route shapes with Flexible Polyline, not Google polyline.
  // Decoder ported from HERE's reference implementation (MIT).
  const decodeFlexPolyline = (encoded: string): Array<[number, number]> => {
    const TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const charValues = new Map<number, number>();
    for (let i = 0; i < TABLE.length; i++) charValues.set(TABLE.charCodeAt(i), i);
    let index = 0;
    const nextUnsigned = (): number => {
      let result = 0;
      let shift = 0;
      for (;;) {
        const value = charValues.get(encoded.charCodeAt(index++));
        if (value === undefined) throw new Error("invalid flexible polyline");
        result += (value & 0x1f) * 2 ** shift;
        shift += 5;
        if ((value & 0x20) === 0) return result;
      }
    };
    const nextSigned = (): number => {
      const value = nextUnsigned();
      return value % 2 === 1 ? -(value + 1) / 2 : value / 2;
    };
    const version = nextUnsigned();
    if (version !== 1) throw new Error(`unsupported flexible polyline version ${version}`);
    const header = nextUnsigned();
    const factor = 10 ** (header & 15);
    const thirdDim = (header >> 4) & 7;
    const coords: Array<[number, number]> = [];
    let lat = 0;
    let lon = 0;
    while (index < encoded.length) {
      lat += nextSigned();
      lon += nextSigned();
      if (thirdDim) nextSigned();
      coords.push([lat / factor, lon / factor]);
    }
    return coords;
  };

  const haversineMeters = (a: [number, number], b: [number, number]): number => {
    const toRad = (deg: number): number => (deg * Math.PI) / 180;
    const dLat = toRad(b[0] - a[0]);
    const dLon = toRad(b[1] - a[1]);
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
    return 12_742_000 * Math.asin(Math.sqrt(h));
  };

  const samplePointsAlong = (
    coords: Array<[number, number]>,
    intervalMeters: number,
  ): Array<[number, number]> => {
    if (coords.length === 0) return [];
    const samples: Array<[number, number]> = [coords[0]!];
    let accumulated = 0;
    for (let i = 1; i < coords.length; i++) {
      accumulated += haversineMeters(coords[i - 1]!, coords[i]!);
      if (accumulated >= intervalMeters) {
        samples.push(coords[i]!);
        accumulated = 0;
      }
    }
    const last = coords[coords.length - 1]!;
    const tail = samples[samples.length - 1]!;
    if (tail[0] !== last[0] || tail[1] !== last[1]) samples.push(last);
    return samples;
  };

  const lookupTownsAlong = async (
    coords: Array<[number, number]>,
    distanceMeters: number,
  ): Promise<string[]> => {
    if (!hereApiKey || coords.length === 0) return [];
    const distanceMiles = distanceMeters / 1609.34;
    const intervalMiles = Math.max(35, distanceMiles / 12);
    const samples = samplePointsAlong(coords, intervalMiles * 1609.34);
    const labels = await Promise.all(samples.map(async ([lat, lon]) => {
      try {
        const url = `https://revgeocode.search.hereapi.com/v1/revgeocode?at=${lat.toFixed(5)},${lon.toFixed(5)}&lang=en-US&apiKey=${hereApiKey}`;
        const response = await fetch(url);
        if (!response.ok) return null;
        const data = await response.json() as {
          items?: Array<{ address?: { city?: string; stateCode?: string } }>;
        };
        const address = data.items?.[0]?.address;
        if (!address?.city) return null;
        return address.stateCode ? `${address.city}, ${address.stateCode}` : address.city;
      } catch {
        return null;
      }
    }));
    const towns: string[] = [];
    for (const label of labels) {
      if (label && !towns.includes(label)) towns.push(label);
    }
    return towns;
  };

  const cumulativeMetersAlong = (coords: Array<[number, number]>): number[] => {
    const cumulative: number[] = [0];
    for (let i = 1; i < coords.length; i++) {
      cumulative.push(cumulative[i - 1]! + haversineMeters(coords[i - 1]!, coords[i]!));
    }
    return cumulative;
  };

  const nearestPointOnRoute = (
    coords: Array<[number, number]>,
    cumulative: number[],
    lat: number,
    lon: number,
  ): { alongMeters: number; offRouteMeters: number } => {
    let alongMeters = 0;
    let offRouteMeters = Number.POSITIVE_INFINITY;
    for (let i = 0; i < coords.length; i++) {
      const d = haversineMeters(coords[i]!, [lat, lon]);
      if (d < offRouteMeters) {
        offRouteMeters = d;
        alongMeters = cumulative[i]!;
      }
    }
    return { alongMeters, offRouteMeters };
  };

  const initialBearingDeg = (a: [number, number], b: [number, number]): number => {
    const toRad = (deg: number): number => (deg * Math.PI) / 180;
    const dLon = toRad(b[1] - a[1]);
    const y = Math.sin(dLon) * Math.cos(toRad(b[0]));
    const x = Math.cos(toRad(a[0])) * Math.sin(toRad(b[0])) -
      Math.sin(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.cos(dLon);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  };

  interface HereRouteData {
    distanceM: number;
    durationS: number;
    baseDurationS: number;
    coords: Array<[number, number]>;
    via: Array<{ road: string; miles: number }>;
  }

  const routeViaHere = async (
    points: ResolvedRoutePoint[],
    mode: RouteMode,
  ): Promise<HereRouteData> => {
    if (!hereApiKey) throw new Error("HERE_API_KEY not configured");
    // radius= lets HERE snap off-road points (parks, trailheads) to the nearest routable path.
    const asWaypoint = (point: ResolvedRoutePoint): string => `${point.lat},${point.lon};radius=10000`;
    const transportMode = mode === "driving" ? "car" : "pedestrian";
    const origin = points[0]!;
    const destination = points[points.length - 1]!;
    const vias = points.slice(1, -1).map((point) => `&via=${asWaypoint(point)}`).join("");
    const url = `https://router.hereapi.com/v8/routes?transportMode=${transportMode}&routingMode=fast` +
      `&origin=${asWaypoint(origin)}&destination=${asWaypoint(destination)}${vias}` +
      `&return=summary,polyline&spans=routeNumbers,length&apiKey=${hereApiKey}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HERE route failed: HTTP ${response.status}`);
    const payload = await response.json() as {
      routes?: Array<{ sections?: Array<{
        summary?: { length?: number; duration?: number; baseDuration?: number };
        polyline?: string;
        spans?: Array<{ routeNumbers?: Array<{ value?: string }>; length?: number }>;
      }> }>;
      notices?: Array<{ title?: string }>;
    };
    const sections = payload.routes?.[0]?.sections;
    if (!sections || sections.length === 0) {
      throw new Error(`HERE route failed: ${payload.notices?.[0]?.title ?? "no route"}`);
    }
    let distanceM = 0;
    let durationS = 0;
    let baseDurationS = 0;
    const coords: Array<[number, number]> = [];
    const roadMeters = new Map<string, number>();
    for (const section of sections) {
      distanceM += section.summary?.length ?? 0;
      durationS += section.summary?.duration ?? 0;
      baseDurationS += section.summary?.baseDuration ?? section.summary?.duration ?? 0;
      if (section.polyline) coords.push(...decodeFlexPolyline(section.polyline));
      for (const span of section.spans ?? []) {
        const road = span.routeNumbers?.[0]?.value;
        if (!road) continue;
        roadMeters.set(road, (roadMeters.get(road) ?? 0) + (span.length ?? 0));
      }
    }
    // Map preserves insertion order, so via reads in route order.
    const via = [...roadMeters.entries()]
      .filter(([, meters]) => meters / 1609.34 >= 5)
      .slice(0, 8)
      .map(([road, meters]) => ({ road, miles: Math.round(meters / 1609.34) }));
    return { distanceM, durationS, baseDurationS, coords, via };
  };

  const routeOne = async (
    route: RouteOption,
    index: number,
    mode: RouteMode,
  ): Promise<RouteResult> => {
    const origin = route.origin ?? "current location";
    const destination = route.destination;
    if (typeof destination !== "string" || destination.trim().length === 0) {
      throw new Error(`route ${index + 1} is missing destination`);
    }
    const waypointInputs = Array.isArray(route.waypoints) ? route.waypoints : [];
    const resolvedPoints = await Promise.all([
      resolvePlace(origin),
      ...waypointInputs.map((waypoint) => resolvePlace(waypoint)),
      resolvePlace(destination),
    ]);
    const label = typeof route.label === "string" && route.label.trim().length > 0
      ? route.label.trim()
      : `route ${index + 1}`;
    const googleMapsUrl = buildGoogleMapsUrl(resolvedPoints, mode);

    let hereError: string | undefined;
    if (hereApiKey) {
      try {
        const here = await routeViaHere(resolvedPoints, mode);
        const durationHours = here.durationS / 3600;
        const passesThrough = await lookupTownsAlong(here.coords, here.distanceM).catch(() => []);
        return {
          label,
          mode,
          source: "here",
          distanceMiles: Number((here.distanceM / 1609.34).toFixed(1)),
          durationHours: Number(durationHours.toFixed(2)),
          durationText: formatDuration(durationHours),
          durationBasis: mode === "driving"
            ? "HERE car route duration with current traffic"
            : "HERE pedestrian route duration",
          baseDurationHours: Number((here.baseDurationS / 3600).toFixed(2)),
          via: here.via,
          passesThrough,
          resolvedPoints,
          googleMapsUrl,
        };
      } catch (err: unknown) {
        hereError = err instanceof Error ? err.message : String(err);
      }
    }

    const coordinates = resolvedPoints.map((point) => `${point.lon},${point.lat}`).join(";");
    const osrmProfile = mode === "driving" ? "driving" : "foot";
    const osrmUrl = `https://router.project-osrm.org/route/v1/${osrmProfile}/${coordinates}?overview=false`;
    const response = await fetch(osrmUrl);
    if (!response.ok) {
      throw new Error(`OSRM route failed for route ${index + 1}: HTTP ${response.status}`);
    }
    const payload = await response.json() as {
      code?: string;
      routes?: Array<{ distance?: number; duration?: number }>;
    };
    const osrmRoute = payload.routes?.[0];
    if (payload.code !== "Ok" || !osrmRoute || typeof osrmRoute.distance !== "number" || typeof osrmRoute.duration !== "number") {
      throw new Error(`OSRM route failed for route ${index + 1}: ${payload.code ?? "no route"}`);
    }

    const distanceMiles = osrmRoute.distance / 1609.34;
    const durationHours = mode === "driving"
      ? osrmRoute.duration / 3600
      : distanceMiles / 3;
    return {
      label,
      mode,
      source: "osrm",
      distanceMiles: Number(distanceMiles.toFixed(1)),
      durationHours: Number(durationHours.toFixed(2)),
      durationText: formatDuration(durationHours),
      durationBasis: mode === "driving"
        ? "OSRM driving route duration without live traffic"
        : "OSRM foot routed distance with walking time estimated at 3 mph",
      resolvedPoints,
      googleMapsUrl,
      osrmUrl,
      warning: mode === "driving"
        ? "OSRM fallback: no live traffic, and rural ETAs run 20-50% high — treat duration as an upper bound. No via/passesThrough route grounding available."
        : "OSRM foot fallback: distance is routed, but pedestrian duration and sidewalk/safety conditions are not verified; duration is estimated at 3 mph. Cross-check in Apple/Google Maps before walking.",
      ...(hereError ? { hereError } : {}),
    };
  };

  const routeInputSchema = {
    type: "object",
    properties: {
      origin: { type: "string", description: "Start place, lat,lon, or current location" },
      destination: { type: "string", description: "End place or lat,lon" },
      waypoints: {
        type: "array",
        items: { type: "string" },
        description: "Optional ordered waypoint places or lat,lon strings",
      },
      routes: {
        type: "array",
        description: "Route options to compare. If present, origin/destination at top level are ignored.",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            origin: { type: "string" },
            destination: { type: "string" },
            waypoints: { type: "array", items: { type: "string" } },
          },
          required: ["destination"],
        },
      },
    },
    required: [],
  };

  const routeHandler = async (
    mode: RouteMode,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    try {
      const routeInputs = Array.isArray(input.routes) && input.routes.length > 0
        ? input.routes.slice(0, 6).map((route) => route as RouteOption)
        : [{
            origin: input.origin ?? "current location",
            destination: input.destination,
            waypoints: input.waypoints,
          }];

      const routes: RouteResult[] = [];
      for (let i = 0; i < routeInputs.length; i++) {
        routes.push(await routeOne(routeInputs[i]!, i, mode));
      }
      const fastest = [...routes].sort((a, b) => a.durationHours - b.durationHours)[0] ?? null;
      const staleLocation = routes.some((route) => route.resolvedPoints.some((point) => (
        point.source === "current_location" &&
        typeof point.ageSec === "number" &&
        point.ageSec > 3600
      )));
      return {
        routeMode: mode,
        routes,
        fastest: fastest
          ? {
              label: fastest.label,
              mode: fastest.mode,
              distanceMiles: fastest.distanceMiles,
              durationHours: fastest.durationHours,
              durationText: fastest.durationText,
              durationBasis: fastest.durationBasis,
            }
          : null,
        ...(staleLocation ? { warning: "Current location is stale; tell the user before relying on it." } : {}),
      };
    } catch (err: unknown) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };

  const readGpsTelemetry = (): { headingDeg: number | null; velocityKmh: number | null } => {
    try {
      const raw = fs.readFileSync(locationFile, "utf-8");
      const data = JSON.parse(raw) as Record<string, unknown>;
      return {
        headingDeg: typeof data.heading === "number" ? data.heading : null,
        velocityKmh: typeof data.velocity === "number" ? data.velocity : null,
      };
    } catch {
      return { headingDeg: null, velocityKmh: null };
    }
  };

  const handleRouteAheadSearch = async (input: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const query = String(input.query ?? "").trim();
    if (!query) {
      return { error: "route_ahead_search requires a non-empty query (e.g. 'rest area', 'Starbucks')." };
    }
    const destinationInput = String(input.destination ?? "").trim();
    if (!destinationInput) {
      return { error: "route_ahead_search requires a destination — the place the driver is heading toward. Without it, 'ahead' is undefined." };
    }
    if (!hereApiKey) {
      return { error: "HERE_API_KEY not configured; route-ahead search is unavailable. Do NOT answer 'what is ahead on my route' from web mile-marker lists or memory — tell the user the tool is unavailable." };
    }

    try {
      const origin = await resolvePlace(input.origin ?? "current location");
      const destination = await resolvePlace(destinationInput);
      const route = await routeViaHere([origin, destination], "driving");
      if (route.coords.length < 2) {
        return { error: "route polyline unavailable; cannot compute what is ahead." };
      }
      const cumulative = cumulativeMetersAlong(route.coords);
      const routeMiles = route.distanceM / 1609.34;

      const maxDetourMiles = (() => {
        const parsed = typeof input.max_detour_miles === "number"
          ? input.max_detour_miles
          : Number.parseFloat(String(input.max_detour_miles ?? ""));
        if (!Number.isFinite(parsed)) return 3;
        return Math.max(0.5, Math.min(15, parsed));
      })();
      const maxAheadMiles = (() => {
        const parsed = typeof input.max_ahead_miles === "number"
          ? input.max_ahead_miles
          : Number.parseFloat(String(input.max_ahead_miles ?? ""));
        if (!Number.isFinite(parsed) || parsed <= 0) return null;
        return parsed;
      })();
      const limit = normalizeLimit(input.limit);

      // Sample search anchors along the corridor ahead. Radius overlaps the
      // interval so POIs between anchors are not missed.
      const intervalMiles = Math.min(30, Math.max(10, routeMiles / 20));
      const anchors = samplePointsAlong(route.coords, intervalMiles * 1609.34)
        .filter(([lat, lon], index) => {
          if (maxAheadMiles === null || index === 0) return true;
          const along = nearestPointOnRoute(route.coords, cumulative, lat, lon).alongMeters;
          return along / 1609.34 <= maxAheadMiles + intervalMiles;
        })
        .slice(0, 30);
      const radiusMeters = Math.round(intervalMiles * 1609.34 * 0.75);

      const seenIds = new Set<string>();
      const rawItems: HereSearchItem[] = [];
      const anchorResults = await Promise.all(anchors.map(async ([lat, lon]) => {
        try {
          const params = new URLSearchParams({
            q: query,
            limit: "20",
            lang: "en-US",
            in: `circle:${lat.toFixed(5)},${lon.toFixed(5)};r=${radiusMeters}`,
            apiKey: hereApiKey,
          });
          const response = await fetch(`https://discover.search.hereapi.com/v1/discover?${params.toString()}`);
          if (!response.ok) return [];
          const data = await response.json() as { items?: HereSearchItem[] };
          return data.items ?? [];
        } catch {
          return [];
        }
      }));
      for (const items of anchorResults) {
        for (const item of items) {
          const key = item.id ?? `${item.title}|${item.position?.lat}|${item.position?.lng}`;
          if (seenIds.has(key)) continue;
          seenIds.add(key);
          rawItems.push(item);
        }
      }

      const results = rawItems
        .map((item) => {
          const parsed = parseLocalBusinessItem(item);
          const lat = item.position?.lat;
          const lon = item.position?.lng;
          if (!parsed || typeof lat !== "number" || typeof lon !== "number") return null;
          const projected = nearestPointOnRoute(route.coords, cumulative, lat, lon);
          const detourMiles = projected.offRouteMeters / 1609.34;
          const milesAhead = projected.alongMeters / 1609.34;
          if (detourMiles > maxDetourMiles) return null;
          // Drop hits projected at the very start of the polyline: they are
          // beside or behind the origin, not meaningfully ahead.
          if (milesAhead < 0.5) return null;
          if (maxAheadMiles !== null && milesAhead > maxAheadMiles) return null;
          const etaMinutes = route.durationS > 0 && route.distanceM > 0
            ? Math.round((route.durationS * (projected.alongMeters / route.distanceM)) / 60)
            : null;
          delete parsed.distanceMiles; // straight-line distance from a search anchor — misleading here
          return {
            ...parsed,
            milesAhead: Number(milesAhead.toFixed(1)),
            ...(etaMinutes !== null ? { etaMinutes } : {}),
            detourMiles: Number(detourMiles.toFixed(2)),
          };
        })
        .filter((item): item is NonNullable<typeof item> => item !== null)
        .sort((a, b) => (a.milesAhead as number) - (b.milesAhead as number))
        .slice(0, limit);

      const warnings: string[] = [];
      if (origin.source === "current_location" && typeof origin.ageSec === "number" && origin.ageSec > 3600) {
        warnings.push(`GPS fix is ${Math.round(origin.ageSec / 60)} minutes old — the driver may no longer be at the route origin. Confirm position before relying on milesAhead values.`);
      }
      if (origin.source === "current_location") {
        const telemetry = readGpsTelemetry();
        const routeBearing = initialBearingDeg(route.coords[0]!, route.coords[Math.min(10, route.coords.length - 1)]!);
        if (
          telemetry.headingDeg !== null &&
          (telemetry.velocityKmh ?? 0) > 30
        ) {
          const diff = Math.abs(((telemetry.headingDeg - routeBearing + 540) % 360) - 180);
          if (diff > 120) {
            warnings.push(`GPS heading (${Math.round(telemetry.headingDeg)}°) points away from the route's initial bearing (${Math.round(routeBearing)}°). The driver may be traveling in the opposite direction of the assumed destination — re-check the destination before answering.`);
          }
        }
      }
      if (results.length === 0) {
        warnings.push(`No '${query}' results found on the route corridor${maxAheadMiles !== null ? ` within ${maxAheadMiles} miles ahead` : ""}. Tell the user none were found ahead — do NOT fill the gap from memory, web mile-marker lists, or general knowledge.`);
      }

      return {
        source: "here-discover-along-route",
        searchedAt: new Date().toISOString(),
        query,
        origin: {
          input: origin.input,
          displayName: origin.displayName,
          lat: origin.lat,
          lon: origin.lon,
          source: origin.source,
          ageSec: origin.ageSec,
        },
        destination: {
          input: destination.input,
          displayName: destination.displayName,
          lat: destination.lat,
          lon: destination.lon,
          source: destination.source,
        },
        route: {
          distanceMiles: Number(routeMiles.toFixed(1)),
          durationHours: Number((route.durationS / 3600).toFixed(2)),
        },
        maxDetourMiles,
        ...(maxAheadMiles !== null ? { maxAheadMiles } : {}),
        resultCount: results.length,
        results,
        warnings,
        grounding: "results are ordered by distance ahead along the route from origin toward destination; milesAhead and etaMinutes are along-route values. Anything not listed was not found on the corridor.",
      };
    } catch (err: unknown) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };

  return [
    {
      name: "location_read",
      description: [
        "Read the current GPS location from the OwnTracks receiver.",
        "Returns: lat, lon, velocity (km/h), heading (degrees), battery %, timestamp, receivedAt, ageSec.",
        "velocity > 0 means actively driving. heading: 0=N 90=E 180=S 270=W.",
        "ageSec = seconds since last GPS update — warn user if > 3600 (stale).",
      ].join("\n"),
      inputSchema: { type: "object", properties: {}, required: [] },
      handler: async () => {
        try {
          const raw = fs.readFileSync(locationFile, "utf-8");
          const data = JSON.parse(raw) as Record<string, unknown>;
          const ageSec = typeof data.timestamp === "number"
            ? Math.round(Date.now() / 1000 - data.timestamp)
            : null;
          return { ...data, ageSec };
        } catch (err: unknown) {
          return { error: `Cannot read location: ${err instanceof Error ? err.message : err}` };
        }
      },
    },

    {
      name: "local_business_search",
      description: [
        "Find candidate local businesses, restaurants, venues, attractions, classes, or activity providers near a place.",
        "Uses HERE Discover with a hard circular area filter, so it is good for broad candidate discovery before web/source verification.",
        "",
        "Parameters:",
        "  query: Free-form search such as 'restaurants', 'cooking class', 'turtle release', or 'coffee shops'.",
        "  near: Place/address/POI, 'lat,lon', or omit/use 'current location'.",
        "  radius_meters: Search radius around the resolved place. Defaults to 12000, max 50000.",
        "  limit: Number of candidates to return. Defaults to 12, max 25.",
        "  categories: Optional HERE category IDs if known; ordinary agents should usually leave this empty and use query text.",
        "",
        "Returns candidate names, addresses, positions, distance, categories, food types, phone numbers, websites, emails, opening-hour text, source id, and a Google Maps search URL.",
        "",
        "Grounding rules:",
        "  This search is a CIRCLE around a point — it is direction-blind. For a driver asking what is AHEAD on their route (next rest area, next food stop), use route_ahead_search instead: circle results include places behind the driver.",
        "  This is a candidate-discovery tool, not final verification. Use official websites/social pages/browser/Exa to verify hours, event times, booking links, phone/WhatsApp numbers, and ratings before recommending or planning.",
        "  If returned contact/opening-hour fields conflict with official pages, treat the official page as stronger evidence and call out the conflict.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free-form local search query." },
          near: { type: "string", description: "Place/address/POI, lat,lon, or current location." },
          radius_meters: { type: "number", description: "Radius around the resolved place; default 12000, max 50000." },
          limit: { type: "number", description: "Candidate count; default 12, max 25." },
          categories: {
            type: "array",
            items: { type: "string" },
            description: "Optional HERE category ids.",
          },
        },
        required: ["query"],
      },
      handler: handleLocalBusinessSearch,
    },

    {
      name: "driving_route",
      description: [
        "Compute real driving routes: distance, traffic-aware ETA, the major roads the route follows, and the towns it passes through. (Formerly named osrm_route.)",
        "This is for cars only. For walking distance, walking ETA, or walk-safety questions, use walking_route instead.",
        "Primary engine is HERE Router v8 (live traffic); falls back to OSRM (no traffic, ETAs run high — a per-route warning is set) when HERE is unavailable.",
        "Never answer route/directions/ETA questions from mental geography when this tool is available.",
        "Place names and POIs (e.g. 'Costco, Fairview, SC') resolve via Nominatim with HERE Discover/Geocode fallback anchored at current GPS.",
        "",
        "Parameters:",
        "  origin: Address/place string, 'lat,lon', or omit/use 'current location' to use GPS. If the user says 'from here', 'from my hotel', or similar and GPS is current, prefer current location over geocoding a remembered address.",
        "  destination: Address/place string or 'lat,lon'.",
        "  waypoints: Optional ordered places the route must pass through.",
        "  routes: Optional array of route options, each with label/origin/destination/waypoints. Use this for comparisons.",
        "",
        "Returns routeMode='driving'. Per route: mode, distanceMiles, durationHours (includes current traffic on HERE), durationText, durationBasis, baseDurationHours (free-flow), via (major roads with miles, in order), passesThrough (towns along the route, in order), resolvedPoints, googleMapsUrl, source; plus the fastest option.",
        "",
        "Grounding rules:",
        "  Read and report the route mode and resolvedPoints before stating distance. If the resolved origin/destination looks wrong, say the route could not be verified.",
        "  Only name a town, stop, or landmark as 'on the route' if it appears in via/passesThrough here or in find_diesel output.",
        "  To claim any other place is on the way, run a comparison: direct route vs a route with that place as a waypoint, and report the added time.",
        "  durationHours already includes traffic — do not add your own traffic multipliers. Add time only for planned stops.",
        "  For 'next rest area / next X ahead of me' questions, use route_ahead_search — this tool computes routes, not POIs ahead.",
      ].join("\n"),
      inputSchema: routeInputSchema,
      handler: async (input) => routeHandler("driving", input),
    },

    {
      name: "walking_route",
      description: [
        "Compute real walking routes for walking distance and walking ETA. Use this for any question about walking, walkability, or whether a route is reasonable on foot.",
        "Primary engine is HERE Router v8 pedestrian routing; falls back to OSRM foot distance when HERE is unavailable.",
        "This tool is not a personal-safety or sidewalk-quality engine. If asked about safety, combine the route with separate current local safety evidence and clearly label what is verified.",
        "Never use driving_route to answer a walking-distance or walking-ETA question.",
        "Place names and POIs resolve via Nominatim with HERE Discover/Geocode fallback anchored at current GPS.",
        "",
        "Parameters:",
        "  origin: Address/place string, 'lat,lon', or omit/use 'current location' to use GPS. If the user says 'from here', 'from my hotel', or similar and GPS is current, prefer current location over geocoding a remembered address.",
        "  destination: Address/place string or 'lat,lon'.",
        "  waypoints: Optional ordered places the walking route must pass through.",
        "  routes: Optional array of walking route options, each with label/origin/destination/waypoints.",
        "",
        "Returns routeMode='walking'. Per route: mode, distanceMiles, durationHours, durationText, durationBasis, resolvedPoints, googleMapsUrl, source, warning when applicable; plus the fastest option.",
        "",
        "Grounding rules:",
        "  Read and report routeMode and resolvedPoints before stating distance. If the resolved origin/destination looks wrong, say the walking route could not be verified.",
        "  If source='osrm', treat duration as an estimate at 3 mph and tell the user to cross-check in Apple/Google Maps before walking.",
        "  Do not claim a route is safe merely because walking_route returned a path.",
      ].join("\n"),
      inputSchema: routeInputSchema,
      handler: async (input) => routeHandler("walking", input),
    },

    {
      name: "route_ahead_search",
      description: [
        "Find POIs AHEAD on the driver's route: rest areas, truck stops, restaurants, chargers, hotels — anything searchable, ordered by miles ahead along the route.",
        "Routes from origin (default: current GPS) toward destination via HERE Router v8, then searches HERE Discover only along that forward corridor. Results are ahead-of-the-driver by construction and include milesAhead, etaMinutes, and detourMiles.",
        "",
        "USE THIS TOOL — not web searches, not memory — for every 'next rest area', 'is there an X in the next N miles', or 'X on my route ahead' question while the user is driving.",
        "NEVER answer such questions from highway mile-marker lists (web or memory): mile-marker direction varies by state and inferring ahead/behind from marker numbers produces confidently-wrong answers. This tool exists because that failure happened.",
        "",
        "Parameters:",
        "  query: What to find — 'rest area', 'truck stop', 'Starbucks', 'EV charging', etc. (required)",
        "  destination: Where the driver is heading — place or lat,lon. Required: 'ahead' is undefined without it. Use the trip destination from context, or ask.",
        "  origin: Start point; omit or 'current location' for live GPS.",
        "  max_ahead_miles: Only return results within this many route-miles ahead (e.g. 50 for 'in the next 50 miles').",
        "  max_detour_miles: Max distance off the route corridor; default 3 (rest areas/highway stops), raise to ~8 for in-town POIs near exits.",
        "  limit: Result count; default 12, max 25.",
        "",
        "Returns resolved origin/destination, route distance/duration, and results sorted by milesAhead with name, address, position, milesAhead, etaMinutes (at route pace), detourMiles, categories, opening hours, googleMapsSearchUrl.",
        "",
        "Grounding rules:",
        "  Report origin.displayName and destination.displayName; if either resolved wrong, say so instead of answering.",
        "  Heed every entry in warnings — especially stale GPS and heading-mismatch warnings — before presenting results.",
        "  If resultCount is 0, tell the user nothing was found ahead in the window. Do not substitute POIs from memory or web lists.",
        "  etaMinutes assumes route-average pace; call it an estimate.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to find ahead: 'rest area', 'truck stop', 'Starbucks', etc." },
          destination: { type: "string", description: "Where the driver is heading — place name, address, or lat,lon." },
          origin: { type: "string", description: "Start point; omit or 'current location' for live GPS." },
          max_ahead_miles: { type: "number", description: "Only return results within this many route-miles ahead." },
          max_detour_miles: { type: "number", description: "Max miles off the route corridor; default 3, max 15." },
          limit: { type: "number", description: "Result count; default 12, max 25." },
        },
        required: ["query", "destination"],
      },
      handler: handleRouteAheadSearch,
    },

    {
      name: "find_diesel",
      description: [
        "Find fuel stations and prices — along a route, near a place, or near the current GPS location.",
        "Route mode searches the ENTIRE route corridor via HERE Fuel Prices AND GasBuddy, merged and deduped (fresher posted price wins; otherSourcePrice flags disagreements). Near modes use HERE with GasBuddy fallback.",
        "",
        "Modes:",
        "  Route (default): set destination — best-value diesel stations along the route from current GPS (or 'from'), scored by price × detour penalty. Each station includes milesAhead (along-route distance from the start) and etaMinutes.",
        "  Near a place: set near=true + destination — all-grade fuel prices around a place or a specific station (e.g. 'Costco, Fairview, SC'). POI names work: geocoding falls back to HERE Discover anchored at the current GPS position.",
        "  Near me: omit destination (or pass 'current location') — stations around the current OwnTracks GPS position.",
        "",
        "Parameters:",
        "  destination: Address, place/POI name, or 'lat,lon'. Omit to search near the current GPS location.",
        "  near: Search around destination (or current GPS) only, no routing",
        "  from: Override start location instead of GPS (e.g. 'Mesa Junction, NV') — route mode only",
        "  top: Number of results (default 5)",
        "  source: Force 'here' or 'gasbuddy' (default: auto with fallback)",
        "",
        "Route mode returns diesel stations with: name, address, dieselPrice ($/gal), milesAhead, etaMinutes, detourMiles, priceSource, googleMapsLink.",
        "Near modes also return a prices object with regular/midgrade/premium/diesel grades when available.",
        "IMPORTANT: Route mode assumes a diesel vehicle. If the user says 'gas' casually, interpret it as diesel unless they say otherwise.",
        "Always recommend stations AHEAD on the route, never behind. Use milesAhead for distance-to-station and range-buffer math — never estimate distances from highway mile markers.",
        "When the user has limited range, compare ALL returned stations within range by dieselPrice before recommending — the list is score-ordered, not a single answer.",
        "If the user reports seeing a better advertised price than anything listed, believe the sign: re-run in near mode at that place to verify, and check sourceErrors to see if a data source failed.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          destination: { type: "string", description: "Route endpoint or place to search near — address, POI name, or lat,lon. Omit for current GPS location." },
          near: { type: "boolean", description: "Search near destination (or current GPS) only, no routing" },
          from: { type: "string", description: "Override start location (default: GPS)" },
          top: { type: "number", description: "Number of results (default 5)" },
          source: { type: "string", enum: ["here", "gasbuddy"], description: "Force data source" },
        },
        required: [],
      },
      handler: async (input) => {
        const destination = typeof input.destination === "string" ? input.destination.trim() : "";
        const scriptArgs: string[] = [dieselScript];
        if (destination) scriptArgs.push(destination);
        if (input.near || !destination) scriptArgs.push("--near");
        if (input.from) scriptArgs.push(`--from=${input.from}`);
        if (typeof input.top === "number") scriptArgs.push(`--top=${input.top}`);
        if (input.source) scriptArgs.push(`--source=${input.source}`);

        const env: Record<string, string> = {
          TANGO_LOCATION_FILE: locationFile,
          ...(process.env.HERE_API_KEY ? { HERE_API_KEY: process.env.HERE_API_KEY } : {}),
        };

        const result = await execCommand(process.execPath, scriptArgs, 60_000, env);
        if (result.code !== 0) {
          return { error: result.stderr.trim() || `Exit ${result.code}`, output: result.stdout.trim() };
        }
        try {
          return JSON.parse(result.stdout);
        } catch {
          return { output: result.stdout.trim() };
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Walmart shopping tool
// ---------------------------------------------------------------------------

export function createWalmartTools(): AgentTool[] {
  return [
    {
      name: "walmart",
      description: [
        "Walmart shopping queue and purchase history — manage a shopping list and analyze purchase patterns.",
        "",
        "## Actions",
        "",
        "### Queue management",
        "  action: 'queue_add'   — Add items to the shopping queue",
        "    items (required): string[] — List of item queries to queue",
        "    note: string — Optional note for all items",
        "",
        "  action: 'queue_list'  — Show current queue",
        "",
        "  action: 'queue_clear' — Clear all items from queue",
        "",
        "  action: 'queue_remove' — Remove specific item by index (0-based)",
        "    index (required): number",
        "",
        "### Purchase history & restock",
        "  action: 'history_analyze' — Parse receipts from the configured Walmart receipts directory",
        "    days_back: number — Days of history to include (default 365)",
        "    top_n: number — Return only top N items by purchase count (default 20)",
        "",
        "  action: 'history_restock' — Get restock recommendations based on purchase patterns",
        "    days_back: number — Days of history to analyze (default 365)",
        "    Returns items grouped by urgency: overdue, soon (≤7 days), upcoming (≤14 days)",
        "",
        "  action: 'history_preferences' — Show saved product preferences",
        "",
        "## Data files",
        "  Queue: profile data or configured Walmart data directory",
        "  Preferences: profile data or configured Walmart data directory",
        "  Receipts: profile data or TANGO_WALMART_RECEIPTS_DIR",
        "",
        "## Browser automation",
        "  Use the `browser` tool to navigate Walmart.com, search for items,",
        "  and add them to cart. This tool only manages the queue and history data.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "queue_add",
              "queue_list",
              "queue_clear",
              "queue_remove",
              "history_analyze",
              "history_restock",
              "history_preferences",
            ],
            description: "Walmart operation to perform",
          },
          items: {
            type: "array",
            items: { type: "string" },
            description: "For queue_add: list of item queries to add",
          },
          query: {
            type: "string",
            description: "For queue_add: single item query (alternative to items array)",
          },
          index: {
            type: "number",
            description: "For queue_remove: 0-based queue index",
          },
          note: {
            type: "string",
            description: "For queue_add: optional note for all queued items",
          },
          days_back: {
            type: "number",
            description: "For history_*: days of purchase history to include (default 365)",
          },
          top_n: {
            type: "number",
            description: "For history_analyze: limit results to top N items (default 20)",
          },
        },
        required: ["action"],
      },
      handler: async (input) => {
        const action = String(input.action);

        switch (action) {
          case "queue_add": {
            const queries = Array.isArray(input.items)
              ? (input.items as string[])
              : input.query ? [String(input.query)]
              : [];
            if (queries.length === 0) {
              return { error: "queue_add requires 'items' array or 'query' string" };
            }
            const note = input.note ? String(input.note) : undefined;
            const added: CartQueueItem[] = [];
            for (const q of queries) {
              added.push(addToQueue(q.trim(), note));
            }
            const queue = loadQueue();
            return {
              added: added.map((i) => i.query),
              queue_length: queue.items.length,
              message: `Added ${added.length} item(s) to queue. Total pending: ${queue.items.filter((i) => i.status === "pending").length}`,
            };
          }

          case "queue_list": {
            const items = listQueue();
            return {
              items: items.map((i, idx) => ({
                index: idx,
                query: i.query,
                status: i.status,
                addedAt: i.addedAt,
                note: i.note,
              })),
              total: items.length,
              pending: items.filter((i) => i.status === "pending").length,
            };
          }

          case "queue_clear": {
            const before = listQueue().length;
            clearQueue();
            return { cleared: before, message: `Cleared ${before} item(s) from queue` };
          }

          case "queue_remove": {
            const idx = typeof input.index === "number" ? input.index : parseInt(String(input.index), 10);
            const removed = removeFromQueue(idx);
            if (!removed) {
              return { error: `No item at index ${idx}` };
            }
            return { removed: removed.query, index: idx };
          }

          case "history_analyze": {
            const daysBack = typeof input.days_back === "number" ? input.days_back : 365;
            const topN = typeof input.top_n === "number" ? input.top_n : 20;
            const records = parseReceipts(daysBack);
            const stats = analyzeHistory(records);
            return {
              total_receipts_items: records.length,
              total_unique_items: stats.length,
              days_analyzed: daysBack,
              items: stats.slice(0, topN).map((s) => ({
                name: s.displayName,
                purchase_count: s.purchaseCount,
                total_spend: s.totalSpend,
                avg_price: s.averagePrice,
                avg_interval_days: s.averageIntervalDays,
                last_purchase: s.lastPurchase,
                next_expected: s.nextExpectedDate,
                days_until_next: s.daysUntilNext,
                is_staple: s.isStaple,
              })),
            };
          }

          case "history_restock": {
            const daysBack = typeof input.days_back === "number" ? input.days_back : 365;
            const records = parseReceipts(daysBack);
            const stats = analyzeHistory(records);
            const recs = getRestockRecommendations(stats);
            return {
              total_recommendations: recs.length,
              overdue: recs.filter((r) => r.urgency === "overdue").map((r) => ({
                name: r.item.displayName,
                days_overdue: r.daysOverdue,
                last_purchase: r.item.lastPurchase,
                avg_price: r.item.averagePrice,
              })),
              soon: recs.filter((r) => r.urgency === "soon").map((r) => ({
                name: r.item.displayName,
                days_until_needed: r.daysUntilNeeded,
                last_purchase: r.item.lastPurchase,
                avg_price: r.item.averagePrice,
              })),
              upcoming: recs.filter((r) => r.urgency === "upcoming").map((r) => ({
                name: r.item.displayName,
                days_until_needed: r.daysUntilNeeded,
                last_purchase: r.item.lastPurchase,
                avg_price: r.item.averagePrice,
              })),
            };
          }

          case "history_preferences": {
            return summarizePreferences();
          }

          default:
            return { error: `Unknown action: ${action}` };
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// File operations tool
// ---------------------------------------------------------------------------

export function createFileOpsTools(): AgentTool[] {
  const home = os.homedir();

  // Directories Sierra is allowed to access
  const ALLOWED_ROOTS = [
    path.join(home, "Downloads"),
    path.join(home, "3d-printing"),
    path.join(home, "Documents"),
  ];

  function isAllowed(p: string): boolean {
    const resolved = path.resolve(p);
    return ALLOWED_ROOTS.some((root) => resolved.startsWith(root));
  }

  return [
    {
      name: "file_ops",
      description: [
        "File operations — list, read, copy, move, append to, and overwrite files in allowed directories.",
        "",
        "Allowed directories: ~/Downloads, ~/3d-printing, ~/Documents",
        "",
        "Actions:",
        "  list — List files in a directory",
        "    path (required): directory path",
        "    pattern: glob filter (e.g. '*.stl', '*.gcode')",
        "",
        "  read — Read a text file (returns first 50KB)",
        "    path (required): file path",
        "",
        "  copy — Copy a file to a new location",
        "    path (required): source file path",
        "    destination (required): destination file path",
        "",
        "  move — Move/rename a file",
        "    path (required): source file path",
        "    destination (required): destination file path",
        "",
        "  append — Append text to the end of a text file",
        "    path (required): file path",
        "    content (required): text to append",
        "",
        "  write — Overwrite a text file with new content",
        "    path (required): file path",
        "    content (required): full replacement text",
        "",
        "Common workflow: list ~/Downloads for new STL files, then copy to ~/3d-printing/gridfinity/stl/",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list", "read", "copy", "move", "append", "write"],
            description: "File operation to perform",
          },
          path: {
            type: "string",
            description: "File or directory path",
          },
          destination: {
            type: "string",
            description: "For copy/move: destination path",
          },
          pattern: {
            type: "string",
            description: "For list: glob filter (e.g. '*.stl')",
          },
          content: {
            type: "string",
            description: "For append/write: text content to write",
          },
        },
        required: ["action", "path"],
      },
      handler: async (input) => {
        const action = String(input.action);
        const filePath = String(input.path).replace(/^~/, home);
        const resolved = path.resolve(filePath);

        if (!isAllowed(resolved)) {
          return { error: `Access denied: ${filePath}. Allowed: ~/Downloads, ~/3d-printing, ~/Documents` };
        }

        switch (action) {
          case "list": {
            if (!fs.existsSync(resolved)) {
              return { error: `Directory not found: ${filePath}` };
            }
            const stat = fs.statSync(resolved);
            if (!stat.isDirectory()) {
              return { error: `Not a directory: ${filePath}` };
            }
            const entries = fs.readdirSync(resolved, { withFileTypes: true });
            let items = entries.map((e) => ({
              name: e.name,
              type: e.isDirectory() ? "directory" as const : "file" as const,
              size: e.isFile() ? fs.statSync(path.join(resolved, e.name)).size : undefined,
            }));

            // Apply glob pattern filter if provided
            if (input.pattern) {
              const pattern = String(input.pattern);
              const regex = new RegExp(
                "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
                "i",
              );
              items = items.filter((i) => i.type === "directory" || regex.test(i.name));
            }

            return { path: filePath, items, count: items.length };
          }

          case "read": {
            if (!fs.existsSync(resolved)) {
              return { error: `File not found: ${filePath}` };
            }
            const content = fs.readFileSync(resolved, "utf8");
            if (content.length > 50_000) {
              return { content: content.slice(0, 50_000), truncated: true, totalLength: content.length };
            }
            return { content };
          }

          case "copy":
          case "move": {
            if (!input.destination) {
              return { error: `${action} requires 'destination'` };
            }
            const destPath = String(input.destination).replace(/^~/, home);
            const destResolved = path.resolve(destPath);

            if (!isAllowed(destResolved)) {
              return { error: `Access denied for destination: ${destPath}. Allowed: ~/Downloads, ~/3d-printing, ~/Documents` };
            }
            if (!fs.existsSync(resolved)) {
              return { error: `Source not found: ${filePath}` };
            }

            // Ensure destination directory exists
            const destDir = path.dirname(destResolved);
            if (!fs.existsSync(destDir)) {
              fs.mkdirSync(destDir, { recursive: true });
            }

            if (action === "copy") {
              fs.copyFileSync(resolved, destResolved);
              return { success: true, action: "copy", from: filePath, to: destPath };
            } else {
              fs.renameSync(resolved, destResolved);
              return { success: true, action: "move", from: filePath, to: destPath };
            }
          }

          case "append":
          case "write": {
            if (typeof input.content !== "string") {
              return { error: `${action} requires 'content'` };
            }
            const nextContent = String(input.content);
            const dir = path.dirname(resolved);
            if (!fs.existsSync(dir)) {
              fs.mkdirSync(dir, { recursive: true });
            }
            if (action === "append") {
              const prefix = fs.existsSync(resolved) && fs.statSync(resolved).size > 0 ? "\n" : "";
              fs.appendFileSync(resolved, `${prefix}${nextContent}`, "utf8");
              return { success: true, action: "append", path: filePath, appended: nextContent.length };
            }
            fs.writeFileSync(resolved, nextContent, "utf8");
            return { success: true, action: "write", path: filePath, bytes: nextContent.length };
          }

          default:
            return { error: `Unknown action: ${action}` };
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// All research tools combined
// ---------------------------------------------------------------------------

export function createAllResearchTools(overrides?: ResearchToolPaths): AgentTool[] {
  return [
    ...createExaTools(overrides),
    ...createPrintingTools(overrides),
    ...createPaperPrintingTools(overrides),
    ...createTravelTools(),
    ...createWalmartTools(),
    ...createFileOpsTools(),
  ];
}
