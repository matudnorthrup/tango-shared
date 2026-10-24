export type EmbeddingInputType = "query" | "document";

export interface EmbeddingProvider {
  readonly model: string;
  embed(texts: string[], inputType?: EmbeddingInputType): Promise<number[][]>;
}

export interface VoyageEmbeddingProviderOptions {
  apiKey: string;
  model?: string;
  endpoint?: string;
  outputDimension?: number;
  timeoutMs?: number;
}

interface VoyageEmbeddingResponse {
  data?: Array<{
    embedding?: number[];
  }>;
  embeddings?: number[][];
}

const DEFAULT_VOYAGE_MODEL = process.env.VOYAGE_EMBED_MODEL?.trim() || "voyage-4-lite";
const DEFAULT_VOYAGE_ENDPOINT =
  process.env.VOYAGE_API_URL?.trim() || "https://api.voyageai.com/v1/embeddings";

export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly outputDimension?: number;
  private readonly timeoutMs: number;

  constructor(options: VoyageEmbeddingProviderOptions) {
    this.apiKey = options.apiKey.trim();
    this.model = options.model?.trim() || DEFAULT_VOYAGE_MODEL;
    this.endpoint = options.endpoint?.trim() || DEFAULT_VOYAGE_ENDPOINT;
    this.outputDimension = options.outputDimension;
    this.timeoutMs = Math.max(options.timeoutMs ?? 10_000, 1_000);
  }

  async embed(texts: string[], inputType?: EmbeddingInputType): Promise<number[][]> {
    const normalizedTexts = texts
      .map((text) => text.trim())
      .filter((text) => text.length > 0);

    if (normalizedTexts.length === 0) {
      return [];
    }

    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        input: normalizedTexts.length === 1 ? normalizedTexts[0] : normalizedTexts,
        model: this.model,
        ...(inputType ? { input_type: inputType } : {}),
        ...(this.outputDimension ? { output_dimension: this.outputDimension } : {}),
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `Voyage embeddings request failed: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ""}`
      );
    }

    const payload = (await response.json()) as VoyageEmbeddingResponse;
    if (Array.isArray(payload.embeddings)) {
      return payload.embeddings.map((embedding) => sanitizeEmbedding(embedding));
    }

    if (Array.isArray(payload.data)) {
      return payload.data.map((item) => sanitizeEmbedding(item.embedding ?? []));
    }

    throw new Error("Voyage embeddings response missing embeddings.");
  }
}

export function createVoyageEmbeddingProviderFromEnv(): EmbeddingProvider | null {
  const apiKey = process.env.VOYAGE_API_KEY?.trim();
  if (!apiKey) return null;

  const outputDimensionValue = process.env.VOYAGE_OUTPUT_DIMENSION?.trim();
  const outputDimension = outputDimensionValue ? Number.parseInt(outputDimensionValue, 10) : undefined;

  return new VoyageEmbeddingProvider({
    apiKey,
    model: process.env.VOYAGE_EMBED_MODEL?.trim() || DEFAULT_VOYAGE_MODEL,
    endpoint: process.env.VOYAGE_API_URL?.trim() || DEFAULT_VOYAGE_ENDPOINT,
    outputDimension: Number.isFinite(outputDimension) ? outputDimension : undefined,
    timeoutMs: parseEnvInt(process.env.VOYAGE_TIMEOUT_MS, 10_000),
  });
}

export function createDeterministicEmbeddingProvider(dimensions = 32): EmbeddingProvider {
  const size = Math.max(8, Math.floor(dimensions));
  return {
    model: "deterministic-test",
    async embed(texts: string[], inputType?: EmbeddingInputType): Promise<number[][]> {
      return texts.map((text) => buildDeterministicVector(text, size, inputType));
    },
  };
}

export function serializeEmbedding(embedding: number[]): string {
  return JSON.stringify(sanitizeEmbedding(embedding));
}

export function deserializeEmbedding(input: string | null | undefined): number[] | null {
  if (!input) return null;
  try {
    const parsed = JSON.parse(input);
    if (!Array.isArray(parsed)) return null;
    return sanitizeEmbedding(parsed);
  } catch {
    return null;
  }
}

export function cosineSimilarity(a: number[], b: number[]): number | null {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return null;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let index = 0; index < a.length; index += 1) {
    const valueA = a[index];
    const valueB = b[index];
    if (valueA === undefined || valueB === undefined) return null;
    dot += valueA * valueB;
    normA += valueA * valueA;
    normB += valueB * valueB;
  }

  if (normA === 0 || normB === 0) return null;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function buildDeterministicVector(
  text: string,
  dimensions: number,
  inputType?: EmbeddingInputType
): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const prefix = inputType === "query" ? "q:" : inputType === "document" ? "d:" : "";
  const normalized = `${prefix}${text}`.trim().toLowerCase();

  for (const token of normalized.split(/\s+/u)) {
    if (!token) continue;
    let hash = 2166136261;
    for (let index = 0; index < token.length; index += 1) {
      hash ^= token.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }

    const bucket = Math.abs(hash) % dimensions;
    const sign = hash % 2 === 0 ? 1 : -1;
    vector[bucket] = (vector[bucket] ?? 0) + sign;
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) return vector;
  return vector.map((value) => value / norm);
}

function sanitizeEmbedding(embedding: unknown[]): number[] {
  return embedding
    .map((value) => (typeof value === "number" ? value : Number(value)))
    .filter((value) => Number.isFinite(value));
}

function parseEnvInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
