import { spawn } from "node:child_process";

export const APPLE_VISION_OCR_METHOD = "apple_vision_ocr";
export const APPLE_VISION_OCR_HELPER_VERSION = 1;

const DEFAULT_SWIFT_COMMAND = "swift";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_AVAILABILITY_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BUFFER_BYTES = 5 * 1024 * 1024;
const DEFAULT_MINIMUM_CONFIDENCE = 0.6;

export type AppleVisionOcrRecognitionLevel = "accurate" | "fast";

export type AppleVisionOcrEscalationReason =
  | "none"
  | "invalid_input"
  | "unavailable"
  | "ocr_failed"
  | "invalid_json"
  | "empty"
  | "low_confidence";

export interface AppleVisionOcrInput {
  imagePath: string;
  pageNumber?: number;
  frameRef?: string;
  sourceRef?: string;
}

export interface AppleVisionOcrBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
  coordinateSpace: "vision_normalized_bottom_left";
}

export interface AppleVisionOcrLine {
  text: string;
  confidence: number | null;
  boundingBox: AppleVisionOcrBoundingBox | null;
  sourceRef: {
    lineIndex: number;
    pageNumber?: number;
    frameRef?: string;
    sourceRef?: string;
  };
}

export interface AppleVisionOcrQuality {
  empty: boolean;
  lowConfidence: boolean;
  lineCount: number;
  textLength: number;
  aggregateConfidence: number | null;
  minimumConfidence: number;
  warningCount: number;
  escalationRecommended: boolean;
  escalationReason: AppleVisionOcrEscalationReason;
}

export interface AppleVisionOcrEscalation {
  recommended: boolean;
  reason: AppleVisionOcrEscalationReason;
  targetMethod: "llm_fallback" | null;
}

export interface AppleVisionOcrMetadata {
  engine: "apple_vision";
  framework: "Vision";
  request: "VNRecognizeTextRequest";
  helperVersion: number;
  platform: NodeJS.Platform;
  swiftCommand: string;
  swiftAvailable: boolean;
  recognitionLevel: AppleVisionOcrRecognitionLevel;
  recognitionLanguages: string[];
  usesLanguageCorrection: boolean;
  minimumTextHeight: number | null;
  durationMs: number;
  source: AppleVisionOcrInput;
  command?: {
    executable: string;
    args: string[];
  };
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stderr?: string;
  rawError?: string;
}

export interface AppleVisionOcrResult {
  method: typeof APPLE_VISION_OCR_METHOD;
  text: string;
  lines: AppleVisionOcrLine[];
  confidence: number | null;
  aggregateConfidence: number | null;
  warnings: string[];
  quality: AppleVisionOcrQuality;
  metadata: AppleVisionOcrMetadata;
  escalation: AppleVisionOcrEscalation;
  available: boolean;
}

export interface AppleVisionOcrRunnerOptions {
  stdin?: string;
  timeoutMs: number;
  maxBufferBytes: number;
}

export interface AppleVisionOcrRunnerResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut?: boolean;
  bufferOverflow?: boolean;
  error?: string;
}

export interface AppleVisionOcrRunner {
  run(
    command: string,
    args: string[],
    options: AppleVisionOcrRunnerOptions,
  ): Promise<AppleVisionOcrRunnerResult>;
}

export interface RunAppleVisionOcrOptions {
  runner?: AppleVisionOcrRunner;
  platform?: NodeJS.Platform;
  swiftCommand?: string;
  timeoutMs?: number;
  availabilityTimeoutMs?: number;
  maxBufferBytes?: number;
  recognitionLevel?: AppleVisionOcrRecognitionLevel;
  recognitionLanguages?: string[];
  usesLanguageCorrection?: boolean;
  minimumTextHeight?: number;
  minimumConfidence?: number;
  skipSwiftAvailabilityCheck?: boolean;
}

interface NormalizedAppleVisionOcrOptions {
  platform: NodeJS.Platform;
  swiftCommand: string;
  timeoutMs: number;
  availabilityTimeoutMs: number;
  maxBufferBytes: number;
  recognitionLevel: AppleVisionOcrRecognitionLevel;
  recognitionLanguages: string[];
  usesLanguageCorrection: boolean;
  minimumTextHeight: number | null;
  minimumConfidence: number;
  skipSwiftAvailabilityCheck: boolean;
}

interface ParsedSwiftPayload {
  text: string;
  lines: AppleVisionOcrLine[];
  warnings: string[];
  rawError?: string;
}

export interface AppleVisionOcrSwiftArgsOptions {
  recognitionLevel: AppleVisionOcrRecognitionLevel;
  recognitionLanguages: string[];
  usesLanguageCorrection: boolean;
  minimumTextHeight: number | null;
}

export const APPLE_VISION_OCR_SWIFT_SOURCE = String.raw`
import Foundation
import Vision
import CoreGraphics
import ImageIO
import Darwin

struct Options {
    var imagePath: String?
    var recognitionLevel: String = "accurate"
    var recognitionLanguages: [String] = []
    var usesLanguageCorrection: Bool = true
    var minimumTextHeight: Double = 0
}

func printJson(_ value: [String: Any]) {
    do {
        let data = try JSONSerialization.data(withJSONObject: value, options: [])
        if let text = String(data: data, encoding: .utf8) {
            print(text)
        }
    } catch {
        print("{\"text\":\"\",\"lines\":[],\"warnings\":[\"failed to serialize OCR output\"]}")
    }
}

func fail(_ code: Int32, _ message: String) -> Never {
    printJson([
        "text": "",
        "lines": [],
        "warnings": [message],
        "error": [
            "message": message
        ]
    ])
    exit(code)
}

func nextValue(_ arguments: [String], _ index: Int) -> String? {
    let valueIndex = index + 1
    guard valueIndex < arguments.count else {
        return nil
    }
    return arguments[valueIndex]
}

func parseOptions() -> Options {
    let arguments = CommandLine.arguments
    var options = Options()
    var index = 1

    while index < arguments.count {
        let argument = arguments[index]
        switch argument {
        case "--image":
            options.imagePath = nextValue(arguments, index)
            index += 1
        case "--recognition-level":
            options.recognitionLevel = nextValue(arguments, index) ?? options.recognitionLevel
            index += 1
        case "--languages":
            let rawLanguages = nextValue(arguments, index) ?? ""
            options.recognitionLanguages = rawLanguages
                .split(separator: ",")
                .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
            index += 1
        case "--uses-language-correction":
            let rawValue = nextValue(arguments, index) ?? "true"
            options.usesLanguageCorrection = rawValue.lowercased() != "false"
            index += 1
        case "--minimum-text-height":
            let rawValue = nextValue(arguments, index) ?? "0"
            options.minimumTextHeight = Double(rawValue) ?? 0
            index += 1
        default:
            break
        }
        index += 1
    }

    return options
}

let options = parseOptions()

guard let imagePath = options.imagePath, !imagePath.isEmpty else {
    fail(64, "missing --image path")
}

let imageUrl = URL(fileURLWithPath: imagePath)
guard FileManager.default.fileExists(atPath: imagePath) else {
    fail(66, "image file does not exist")
}

guard let source = CGImageSourceCreateWithURL(imageUrl as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    fail(65, "failed to load image")
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = options.recognitionLevel == "fast" ? .fast : .accurate
request.usesLanguageCorrection = options.usesLanguageCorrection
if !options.recognitionLanguages.isEmpty {
    request.recognitionLanguages = options.recognitionLanguages
}
if options.minimumTextHeight > 0 {
    request.minimumTextHeight = Float(options.minimumTextHeight)
}

let handler = VNImageRequestHandler(cgImage: image, options: [:])

do {
    try handler.perform([request])
} catch {
    fail(70, "Vision OCR failed: \(error.localizedDescription)")
}

let observations = request.results ?? []
var lines: [[String: Any]] = []

for (index, observation) in observations.enumerated() {
    guard let candidate = observation.topCandidates(1).first else {
        continue
    }

    let box = observation.boundingBox
    lines.append([
        "text": candidate.string,
        "confidence": Double(candidate.confidence),
        "boundingBox": [
            "x": Double(box.origin.x),
            "y": Double(box.origin.y),
            "width": Double(box.width),
            "height": Double(box.height),
            "coordinateSpace": "vision_normalized_bottom_left"
        ],
        "sourceRef": [
            "lineIndex": index
        ]
    ])
}

let joinedText = lines
    .compactMap { $0["text"] as? String }
    .joined(separator: "\n")

printJson([
    "text": joinedText,
    "lines": lines,
    "warnings": [],
    "metadata": [
        "requestRevision": request.revision,
        "recognitionLevel": options.recognitionLevel
    ]
])
`;

export async function runAppleVisionOcr(
  input: string | AppleVisionOcrInput,
  options: RunAppleVisionOcrOptions = {},
): Promise<AppleVisionOcrResult> {
  const startedAt = Date.now();
  const normalizedInput = normalizeInput(input);
  const normalizedOptions = normalizeOptions(options);
  const runner = options.runner ?? defaultAppleVisionOcrRunner;

  if (!normalizedInput.imagePath.trim()) {
    return buildResult({
      input: normalizedInput,
      options: normalizedOptions,
      startedAt,
      available: false,
      warnings: ["Apple Vision OCR input did not include an image path."],
      escalationReason: "invalid_input",
    });
  }

  if (normalizedOptions.platform !== "darwin") {
    return buildResult({
      input: normalizedInput,
      options: normalizedOptions,
      startedAt,
      available: false,
      warnings: ["Apple Vision OCR is only available on macOS."],
      escalationReason: "unavailable",
    });
  }

  if (!normalizedOptions.skipSwiftAvailabilityCheck) {
    const availability = await runWithRunner(
      runner,
      normalizedOptions.swiftCommand,
      ["--version"],
      {
        timeoutMs: normalizedOptions.availabilityTimeoutMs,
        maxBufferBytes: 64 * 1024,
      },
    );

    if (availability.error || availability.timedOut || availability.code !== 0) {
      const warning = availability.timedOut
        ? "Swift availability check timed out."
        : `Swift is not available for Apple Vision OCR${availability.error ? `: ${availability.error}` : ""}.`;
      return buildResult({
        input: normalizedInput,
        options: normalizedOptions,
        startedAt,
        available: false,
        warnings: [warning],
        escalationReason: "unavailable",
        runnerResult: availability,
      });
    }
  }

  const args = buildAppleVisionOcrSwiftArgs(normalizedInput, normalizedOptions);
  const runnerResult = await runWithRunner(
    runner,
    normalizedOptions.swiftCommand,
    args,
    {
      stdin: APPLE_VISION_OCR_SWIFT_SOURCE,
      timeoutMs: normalizedOptions.timeoutMs,
      maxBufferBytes: normalizedOptions.maxBufferBytes,
    },
  );

  const commandWarnings = warningsFromRunnerResult(runnerResult);
  if (runnerResult.error || runnerResult.timedOut || runnerResult.bufferOverflow) {
    return buildResult({
      input: normalizedInput,
      options: normalizedOptions,
      startedAt,
      available: true,
      warnings: commandWarnings,
      escalationReason: "ocr_failed",
      runnerResult,
      commandArgs: args,
    });
  }

  const parsed = parseSwiftPayload(runnerResult.stdout, normalizedInput);
  if (!parsed) {
    return buildResult({
      input: normalizedInput,
      options: normalizedOptions,
      startedAt,
      available: true,
      warnings: [
        ...commandWarnings,
        "Apple Vision OCR returned invalid JSON.",
      ],
      escalationReason: "invalid_json",
      runnerResult,
      commandArgs: args,
    });
  }

  const warnings = [
    ...parsed.warnings,
    ...commandWarnings,
  ];
  let escalationReason: AppleVisionOcrEscalationReason | undefined;
  if (runnerResult.code !== 0 && parsed.text.trim().length === 0) {
    escalationReason = "ocr_failed";
  }
  if (parsed.rawError) {
    warnings.push(`Apple Vision OCR error: ${parsed.rawError}`);
  }

  return buildResult({
    input: normalizedInput,
    options: normalizedOptions,
    startedAt,
    available: true,
    text: parsed.text,
    lines: parsed.lines,
    warnings,
    escalationReason,
    runnerResult,
    commandArgs: args,
    rawError: parsed.rawError,
  });
}

export function buildAppleVisionOcrSwiftArgs(
  input: AppleVisionOcrInput,
  options: AppleVisionOcrSwiftArgsOptions,
): string[] {
  const args = [
    "-",
    "--image",
    input.imagePath,
    "--recognition-level",
    options.recognitionLevel,
    "--uses-language-correction",
    String(options.usesLanguageCorrection),
  ];

  if (options.recognitionLanguages.length > 0) {
    args.push("--languages", options.recognitionLanguages.join(","));
  }
  if (options.minimumTextHeight !== null) {
    args.push("--minimum-text-height", String(options.minimumTextHeight));
  }

  return args;
}

function normalizeInput(input: string | AppleVisionOcrInput): AppleVisionOcrInput {
  if (typeof input === "string") {
    return { imagePath: input };
  }

  return {
    imagePath: input.imagePath,
    ...(input.pageNumber !== undefined ? { pageNumber: input.pageNumber } : {}),
    ...(input.frameRef !== undefined ? { frameRef: input.frameRef } : {}),
    ...(input.sourceRef !== undefined ? { sourceRef: input.sourceRef } : {}),
  };
}

function normalizeOptions(options: RunAppleVisionOcrOptions): NormalizedAppleVisionOcrOptions {
  return {
    platform: options.platform ?? process.platform,
    swiftCommand: options.swiftCommand?.trim() || DEFAULT_SWIFT_COMMAND,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    availabilityTimeoutMs: options.availabilityTimeoutMs ?? DEFAULT_AVAILABILITY_TIMEOUT_MS,
    maxBufferBytes: options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES,
    recognitionLevel: options.recognitionLevel ?? "accurate",
    recognitionLanguages: normalizeStringList(options.recognitionLanguages),
    usesLanguageCorrection: options.usesLanguageCorrection ?? true,
    minimumTextHeight: options.minimumTextHeight ?? null,
    minimumConfidence: options.minimumConfidence ?? DEFAULT_MINIMUM_CONFIDENCE,
    skipSwiftAvailabilityCheck: options.skipSwiftAvailabilityCheck ?? false,
  };
}

function normalizeStringList(values: string[] | undefined): string[] {
  if (!values) return [];
  return values
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function warningsFromRunnerResult(result: AppleVisionOcrRunnerResult): string[] {
  const warnings: string[] = [];

  if (result.timedOut) {
    warnings.push("Apple Vision OCR timed out.");
  }
  if (result.bufferOverflow) {
    warnings.push("Apple Vision OCR output exceeded the buffer limit.");
  }
  if (result.error) {
    warnings.push(`Apple Vision OCR command failed: ${result.error}`);
  }
  if (result.code !== 0 && result.code !== null) {
    warnings.push(`Apple Vision OCR exited with code ${result.code}.`);
  }

  return warnings;
}

function parseSwiftPayload(
  stdout: string,
  input: AppleVisionOcrInput,
): ParsedSwiftPayload | null {
  const payload = parseJsonObject(stdout);
  if (!payload) return null;

  const rawLines = Array.isArray(payload.lines) ? payload.lines : [];
  const lines: AppleVisionOcrLine[] = [];

  rawLines.forEach((rawLine, index) => {
    const record = asRecord(rawLine);
    if (!record) return;

    const text = typeof record.text === "string" ? record.text : "";
    if (!text.trim()) return;

    lines.push({
      text,
      confidence: normalizeConfidence(record.confidence),
      boundingBox: normalizeBoundingBox(record.boundingBox),
      sourceRef: {
        lineIndex: index,
        ...(input.pageNumber !== undefined ? { pageNumber: input.pageNumber } : {}),
        ...(input.frameRef !== undefined ? { frameRef: input.frameRef } : {}),
        ...(input.sourceRef !== undefined ? { sourceRef: input.sourceRef } : {}),
      },
    });
  });

  const text = typeof payload.text === "string"
    ? payload.text
    : lines.map((line) => line.text).join("\n");

  return {
    text,
    lines,
    warnings: normalizeWarnings(payload.warnings),
    rawError: normalizePayloadError(payload.error),
  };
}

function parseJsonObject(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;

  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return null;

    try {
      return asRecord(JSON.parse(trimmed.slice(start, end + 1)));
    } catch {
      return null;
    }
  }
}

function normalizeWarnings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function normalizePayloadError(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  return typeof record.message === "string" && record.message.trim()
    ? record.message.trim()
    : undefined;
}

function normalizeBoundingBox(value: unknown): AppleVisionOcrBoundingBox | null {
  const record = asRecord(value);
  if (!record) return null;

  const x = numberOrNull(record.x);
  const y = numberOrNull(record.y);
  const width = numberOrNull(record.width);
  const height = numberOrNull(record.height);
  if (x === null || y === null || width === null || height === null) {
    return null;
  }

  return {
    x,
    y,
    width,
    height,
    coordinateSpace: "vision_normalized_bottom_left",
  };
}

function normalizeConfidence(value: unknown): number | null {
  const confidence = numberOrNull(value);
  if (confidence === null) return null;
  return roundConfidence(Math.min(1, Math.max(0, confidence)));
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

function aggregateConfidence(lines: AppleVisionOcrLine[]): number | null {
  const confidences = lines
    .map((line) => line.confidence)
    .filter((confidence): confidence is number => confidence !== null);
  if (confidences.length === 0) return null;

  const total = confidences.reduce((sum, confidence) => sum + confidence, 0);
  return roundConfidence(total / confidences.length);
}

function roundConfidence(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function buildResult(input: {
  input: AppleVisionOcrInput;
  options: NormalizedAppleVisionOcrOptions;
  startedAt: number;
  available: boolean;
  text?: string;
  lines?: AppleVisionOcrLine[];
  warnings: string[];
  escalationReason?: AppleVisionOcrEscalationReason;
  runnerResult?: AppleVisionOcrRunnerResult;
  commandArgs?: string[];
  rawError?: string;
}): AppleVisionOcrResult {
  const text = input.text ?? "";
  const lines = input.lines ?? [];
  const confidence = aggregateConfidence(lines);
  const reason = input.escalationReason ?? inferEscalationReason({
    text,
    confidence,
    minimumConfidence: input.options.minimumConfidence,
  });
  const escalationRecommended = reason !== "none";
  const warnings = dedupeWarnings(input.warnings);

  return {
    method: APPLE_VISION_OCR_METHOD,
    text,
    lines,
    confidence,
    aggregateConfidence: confidence,
    warnings,
    quality: {
      empty: text.trim().length === 0,
      lowConfidence: confidence !== null && confidence < input.options.minimumConfidence,
      lineCount: lines.length,
      textLength: text.trim().length,
      aggregateConfidence: confidence,
      minimumConfidence: input.options.minimumConfidence,
      warningCount: warnings.length,
      escalationRecommended,
      escalationReason: reason,
    },
    metadata: {
      engine: "apple_vision",
      framework: "Vision",
      request: "VNRecognizeTextRequest",
      helperVersion: APPLE_VISION_OCR_HELPER_VERSION,
      platform: input.options.platform,
      swiftCommand: input.options.swiftCommand,
      swiftAvailable: input.available,
      recognitionLevel: input.options.recognitionLevel,
      recognitionLanguages: input.options.recognitionLanguages,
      usesLanguageCorrection: input.options.usesLanguageCorrection,
      minimumTextHeight: input.options.minimumTextHeight,
      durationMs: Date.now() - input.startedAt,
      source: input.input,
      ...(input.commandArgs ? {
        command: {
          executable: input.options.swiftCommand,
          args: input.commandArgs,
        },
      } : {}),
      ...(input.runnerResult ? {
        exitCode: input.runnerResult.code,
        signal: input.runnerResult.signal,
      } : {}),
      ...(input.runnerResult?.stderr.trim() ? {
        stderr: input.runnerResult.stderr.trim().slice(0, 1_000),
      } : {}),
      ...(input.rawError ? { rawError: input.rawError } : {}),
    },
    escalation: {
      recommended: escalationRecommended,
      reason,
      targetMethod: escalationRecommended ? "llm_fallback" : null,
    },
    available: input.available,
  };
}

function inferEscalationReason(input: {
  text: string;
  confidence: number | null;
  minimumConfidence: number;
}): AppleVisionOcrEscalationReason {
  if (input.text.trim().length === 0) {
    return "empty";
  }
  if (input.confidence !== null && input.confidence < input.minimumConfidence) {
    return "low_confidence";
  }
  return "none";
}

function dedupeWarnings(warnings: string[]): string[] {
  return Array.from(new Set(warnings.map((warning) => warning.trim()).filter(Boolean)));
}

async function runWithRunner(
  runner: AppleVisionOcrRunner,
  command: string,
  args: string[],
  options: AppleVisionOcrRunnerOptions,
): Promise<AppleVisionOcrRunnerResult> {
  try {
    return await runner.run(command, args, options);
  } catch (error) {
    return {
      stdout: "",
      stderr: "",
      code: null,
      signal: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const defaultAppleVisionOcrRunner: AppleVisionOcrRunner = {
  run: runCommand,
};

async function runCommand(
  command: string,
  args: string[],
  options: AppleVisionOcrRunnerOptions,
): Promise<AppleVisionOcrRunnerResult> {
  return await new Promise<AppleVisionOcrRunnerResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let bufferOverflow = false;
    let settled = false;

    const finish = (result: AppleVisionOcrRunnerResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 2_000).unref();
    }, options.timeoutMs);
    timeoutHandle.unref();

    const appendChunk = (target: "stdout" | "stderr", chunk: Buffer | string) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      const bytes = Buffer.byteLength(text, "utf8");

      if (target === "stdout") {
        stdoutBytes += bytes;
        stdout += text;
      } else {
        stderrBytes += bytes;
        stderr += text;
      }

      if (stdoutBytes + stderrBytes > options.maxBufferBytes) {
        bufferOverflow = true;
        child.kill("SIGTERM");
      }
    };

    child.stdout.on("data", (chunk) => {
      appendChunk("stdout", chunk);
    });
    child.stderr.on("data", (chunk) => {
      appendChunk("stderr", chunk);
    });

    child.on("error", (error) => {
      clearTimeout(timeoutHandle);
      finish({
        stdout,
        stderr,
        code: null,
        signal: null,
        timedOut,
        bufferOverflow,
        error: error.message,
      });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timeoutHandle);
      finish({
        stdout,
        stderr,
        code,
        signal,
        timedOut,
        bufferOverflow,
      });
    });

    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}
