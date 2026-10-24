import { describe, expect, it } from "vitest";
import {
  APPLE_VISION_OCR_METHOD,
  type AppleVisionOcrRunner,
  type AppleVisionOcrRunnerOptions,
  type AppleVisionOcrRunnerResult,
  runAppleVisionOcr,
} from "../src/apple-vision-ocr.js";

interface RunnerCall {
  command: string;
  args: string[];
  options: AppleVisionOcrRunnerOptions;
}

class FakeRunner implements AppleVisionOcrRunner {
  readonly calls: RunnerCall[] = [];
  private readonly results: AppleVisionOcrRunnerResult[];

  constructor(results: AppleVisionOcrRunnerResult[]) {
    this.results = [...results];
  }

  async run(
    command: string,
    args: string[],
    options: AppleVisionOcrRunnerOptions,
  ): Promise<AppleVisionOcrRunnerResult> {
    this.calls.push({ command, args, options });
    const result = this.results.shift();
    if (!result) {
      throw new Error("FakeRunner did not receive an expected result.");
    }
    return result;
  }
}

function runnerResult(overrides: Partial<AppleVisionOcrRunnerResult> = {}): AppleVisionOcrRunnerResult {
  return {
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    ...overrides,
  };
}

describe("runAppleVisionOcr", () => {
  it("constructs a Swift stdin command and parses structured OCR output", async () => {
    const runner = new FakeRunner([
      runnerResult({ stdout: "Apple Swift version 6.3" }),
      runnerResult({
        stdout: JSON.stringify({
          text: "Corner Market\nTotal $12.34",
          lines: [
            {
              text: "Corner Market",
              confidence: 0.8,
              boundingBox: {
                x: 0.1,
                y: 0.7,
                width: 0.5,
                height: 0.1,
                coordinateSpace: "vision_normalized_bottom_left",
              },
            },
            {
              text: "Total $12.34",
              confidence: 0.6,
              boundingBox: {
                x: 0.1,
                y: 0.5,
                width: 0.4,
                height: 0.1,
                coordinateSpace: "vision_normalized_bottom_left",
              },
            },
          ],
        }),
      }),
    ]);

    const result = await runAppleVisionOcr(
      {
        imagePath: "/tmp/receipt.png",
        pageNumber: 2,
        sourceRef: "attachment:123",
      },
      {
        runner,
        platform: "darwin",
        swiftCommand: "swift-custom",
        recognitionLevel: "fast",
        recognitionLanguages: ["en-US", " "],
        usesLanguageCorrection: false,
        minimumTextHeight: 0.02,
        minimumConfidence: 0.5,
      },
    );

    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[0]).toMatchObject({
      command: "swift-custom",
      args: ["--version"],
    });
    expect(runner.calls[1]?.command).toBe("swift-custom");
    expect(runner.calls[1]?.args).toEqual([
      "-",
      "--image",
      "/tmp/receipt.png",
      "--recognition-level",
      "fast",
      "--uses-language-correction",
      "false",
      "--languages",
      "en-US",
      "--minimum-text-height",
      "0.02",
    ]);
    expect(runner.calls[1]?.options.stdin).toContain("VNRecognizeTextRequest");

    expect(result).toMatchObject({
      method: APPLE_VISION_OCR_METHOD,
      text: "Corner Market\nTotal $12.34",
      confidence: 0.7,
      aggregateConfidence: 0.7,
      available: true,
      escalation: {
        recommended: false,
        reason: "none",
        targetMethod: null,
      },
      quality: {
        empty: false,
        lowConfidence: false,
        lineCount: 2,
        aggregateConfidence: 0.7,
      },
      metadata: {
        engine: "apple_vision",
        framework: "Vision",
        request: "VNRecognizeTextRequest",
        swiftCommand: "swift-custom",
        swiftAvailable: true,
        recognitionLevel: "fast",
        recognitionLanguages: ["en-US"],
      },
    });
    expect(result.lines[0]).toMatchObject({
      text: "Corner Market",
      confidence: 0.8,
      boundingBox: {
        x: 0.1,
        y: 0.7,
        width: 0.5,
        height: 0.1,
        coordinateSpace: "vision_normalized_bottom_left",
      },
      sourceRef: {
        lineIndex: 0,
        pageNumber: 2,
        sourceRef: "attachment:123",
      },
    });
  });

  it("fails gracefully without invoking Swift on non-macOS platforms", async () => {
    const runner = new FakeRunner([]);

    const result = await runAppleVisionOcr("/tmp/image.png", {
      runner,
      platform: "linux",
    });

    expect(runner.calls).toHaveLength(0);
    expect(result).toMatchObject({
      text: "",
      lines: [],
      confidence: null,
      available: false,
      escalation: {
        recommended: true,
        reason: "unavailable",
        targetMethod: "llm_fallback",
      },
      quality: {
        empty: true,
        escalationRecommended: true,
      },
    });
    expect(result.warnings).toContain("Apple Vision OCR is only available on macOS.");
  });

  it("reports Swift unavailability without throwing", async () => {
    const runner = new FakeRunner([
      runnerResult({
        code: null,
        error: "spawn swift ENOENT",
      }),
    ]);

    const result = await runAppleVisionOcr("/tmp/image.png", {
      runner,
      platform: "darwin",
    });

    expect(runner.calls).toHaveLength(1);
    expect(result.available).toBe(false);
    expect(result.escalation.reason).toBe("unavailable");
    expect(result.warnings.join("\n")).toContain("spawn swift ENOENT");
  });

  it("turns runner exceptions into structured unavailable results", async () => {
    const runner: AppleVisionOcrRunner = {
      async run() {
        throw new Error("runner exploded");
      },
    };

    const result = await runAppleVisionOcr("/tmp/image.png", {
      runner,
      platform: "darwin",
    });

    expect(result.available).toBe(false);
    expect(result.escalation.reason).toBe("unavailable");
    expect(result.warnings.join("\n")).toContain("runner exploded");
  });

  it("recommends LLM fallback for empty OCR output", async () => {
    const runner = new FakeRunner([
      runnerResult({ stdout: "Apple Swift version 6.3" }),
      runnerResult({
        stdout: JSON.stringify({
          text: "",
          lines: [],
          warnings: [],
        }),
      }),
    ]);

    const result = await runAppleVisionOcr("/tmp/blank.png", {
      runner,
      platform: "darwin",
    });

    expect(result).toMatchObject({
      text: "",
      confidence: null,
      escalation: {
        recommended: true,
        reason: "empty",
        targetMethod: "llm_fallback",
      },
      quality: {
        empty: true,
        lineCount: 0,
      },
    });
  });

  it("recommends escalation for low aggregate confidence", async () => {
    const runner = new FakeRunner([
      runnerResult({ stdout: "Apple Swift version 6.3" }),
      runnerResult({
        stdout: JSON.stringify({
          lines: [
            { text: "faint total", confidence: 0.25 },
            { text: "maybe 12.34", confidence: 0.35 },
          ],
        }),
      }),
    ]);

    const result = await runAppleVisionOcr("/tmp/faint.png", {
      runner,
      platform: "darwin",
      minimumConfidence: 0.5,
    });

    expect(result.text).toBe("faint total\nmaybe 12.34");
    expect(result.confidence).toBe(0.3);
    expect(result).toMatchObject({
      escalation: {
        recommended: true,
        reason: "low_confidence",
        targetMethod: "llm_fallback",
      },
      quality: {
        lowConfidence: true,
        aggregateConfidence: 0.3,
      },
    });
  });

  it("handles invalid Swift JSON as a graceful OCR failure", async () => {
    const runner = new FakeRunner([
      runnerResult({ stdout: "Apple Swift version 6.3" }),
      runnerResult({
        stdout: "this is not json",
      }),
    ]);

    const result = await runAppleVisionOcr("/tmp/image.png", {
      runner,
      platform: "darwin",
    });

    expect(result).toMatchObject({
      text: "",
      lines: [],
      available: true,
      escalation: {
        recommended: true,
        reason: "invalid_json",
        targetMethod: "llm_fallback",
      },
    });
    expect(result.warnings).toContain("Apple Vision OCR returned invalid JSON.");
  });
});
