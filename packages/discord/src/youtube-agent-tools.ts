/**
 * YouTube Agent Tools — Transcript extraction and video analysis.
 *
 * Tools:
 *   - youtube_transcript: Extract captions/transcript from a YouTube video
 *   - youtube_analyze: Analyze a YouTube video using Gemini (Vertex AI)
 */

import { GoogleGenAI } from "@google/genai";
import type { AgentTool } from "@tango/core";
import type { TranscriptConfig, TranscriptResponse } from "youtube-transcript";

const debug = (...args: unknown[]) => {
  console.error("[youtube-tools]", ...args);
};

// ---------------------------------------------------------------------------
// Gemini client (Vertex AI via ADC)
// ---------------------------------------------------------------------------

let genaiInstance: GoogleGenAI | null = null;
let youtubeTranscriptModulePromise:
  Promise<{ fetchTranscript(videoId: string, config?: TranscriptConfig): Promise<TranscriptResponse[]> }>
  | null = null;

function getGenAI(): GoogleGenAI {
  if (genaiInstance) return genaiInstance;

  const project = process.env.GCP_PROJECT_ID;
  if (!project) {
    throw new Error("GCP_PROJECT_ID environment variable is required for youtube_analyze");
  }

  genaiInstance = new GoogleGenAI({
    vertexai: true,
    project,
    location: process.env.GCP_LOCATION || "us-central1",
  });

  debug(`Gemini client initialized (project=${project}, location=${process.env.GCP_LOCATION || "us-central1"})`);
  return genaiInstance;
}

async function fetchYouTubeTranscript(
  videoId: string,
  config?: TranscriptConfig,
): Promise<TranscriptResponse[]> {
  if (!youtubeTranscriptModulePromise) {
    youtubeTranscriptModulePromise = import(
      "youtube-transcript/dist/youtube-transcript.esm.js"
    ) as Promise<{
      fetchTranscript(videoId: string, config?: TranscriptConfig): Promise<TranscriptResponse[]>;
    }>;
  }

  const module = await youtubeTranscriptModulePromise;
  return module.fetchTranscript(videoId, config);
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export function createYouTubeTools(): AgentTool[] {
  return [
    {
      name: "youtube_transcript",
      description: [
        "Extract the transcript/captions from a YouTube video.",
        "Returns the full text and optional timestamped segments.",
        "No API key needed — works with any public video that has captions.",
        "",
        "Parameters:",
        "  url (required): YouTube video URL or video ID",
        "  timestamps: Include timestamp offsets in output (default false)",
        "",
        "Use for: Analyzing what was said in a video, searching for specific quotes,",
        "summarizing talks/lectures/podcasts. Does NOT analyze visual content.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "YouTube video URL or video ID" },
          timestamps: { type: "boolean", description: "Include timestamps (default false)" },
        },
        required: ["url"],
      },
      handler: async (input) => {
        const url = String(input.url);
        debug(`Fetching transcript for: ${url}`);
        try {
          const segments = await fetchYouTubeTranscript(url);
          const fullText = segments.map((s) => s.text).join(" ");

          if (input.timestamps) {
            return {
              text: fullText,
              segments: segments.map((s) => ({
                text: s.text,
                offsetSec: Math.round(s.offset / 1000),
                durationSec: Math.round(s.duration / 1000),
              })),
              segmentCount: segments.length,
            };
          }
          return { text: fullText, segmentCount: segments.length };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          debug(`Transcript failed: ${msg}`);
          return { error: `Transcript extraction failed: ${msg}` };
        }
      },
    },

    {
      name: "youtube_analyze",
      description: [
        "Analyze a YouTube video using Google Gemini (Vertex AI).",
        "Gemini processes the actual video — visual frames, audio, and speech.",
        "Can answer questions about what's shown, summarize content, extract information.",
        "",
        "Parameters:",
        "  url (required): YouTube video URL",
        "  prompt (required): What to analyze or ask about the video",
        "  model: Gemini model (default 'gemini-2.5-flash')",
        "",
        "Cost: ~$0.02-0.07 per 10 minutes of video.",
        "Limitation: Public videos only.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "YouTube video URL" },
          prompt: { type: "string", description: "What to analyze or ask about the video" },
          model: { type: "string", description: "Gemini model (default 'gemini-2.5-flash')" },
        },
        required: ["url", "prompt"],
      },
      handler: async (input) => {
        const url = String(input.url);
        const prompt = String(input.prompt);
        const model = String(input.model || "gemini-2.5-flash");
        debug(`Analyzing video: ${url} (model=${model})`);

        try {
          const ai = getGenAI();
          const response = await ai.models.generateContent({
            model,
            contents: [
              { fileData: { fileUri: url } },
              { text: prompt },
            ],
          });
          debug(`Analysis complete (model=${model})`);
          return { analysis: response.text, model };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          debug(`Analysis failed: ${msg}`);
          return { error: `Video analysis failed: ${msg}` };
        }
      },
    },
  ];
}
