# YouTube Tools

Shared doc for `youtube_transcript` and `youtube_analyze`.

## `youtube_transcript`

Extract captions/transcript text from any public YouTube video. No API key needed.

Input:

```json
{
  "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "timestamps": true
}
```

- `url` (required): YouTube URL or video ID
- `timestamps`: Include per-segment timing (default false)

Returns `text` (full transcript as a single string) and optionally `segments` with `offsetSec` / `durationSec`.

Best for: speech-heavy content (podcasts, lectures, interviews). Fast and free.

## `youtube_analyze`

Analyze a YouTube video using Gemini (Vertex AI). Gemini processes the actual video — visual frames, audio, and speech — not just the transcript.

Input:

```json
{
  "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "prompt": "Summarize this video and list the key topics discussed.",
  "model": "gemini-2.5-flash"
}
```

- `url` (required): YouTube URL
- `prompt` (required): What to analyze or ask about the video
- `model`: Gemini model (default `gemini-2.5-flash`)

Returns `analysis` (Gemini's response text) and `model`.

Best for: visual content, comprehensive analysis, Q&A about what's shown in the video.

## When to use which

- **Transcript only needed?** Use `youtube_transcript` — it's free and instant.
- **Need to understand what's shown?** Use `youtube_analyze` — it sees the video.
- **Deep analysis of a talk?** Use `youtube_transcript` first to get exact quotes, then `youtube_analyze` if visual context matters.
