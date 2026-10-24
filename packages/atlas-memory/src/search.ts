import type {
  EmbeddingInputType,
  EmbeddingProvider,
  MemoryRecord,
} from "./types.js";

interface VoyageEmbeddingProviderOptions {
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
        `Voyage embeddings request failed: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ""}`,
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

export function createVoyageEmbeddingProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): EmbeddingProvider | null {
  const apiKey = env.VOYAGE_API_KEY?.trim();
  if (!apiKey) {
    return null;
  }

  const outputDimensionValue = env.VOYAGE_OUTPUT_DIMENSION?.trim();
  const outputDimension = outputDimensionValue
    ? Number.parseInt(outputDimensionValue, 10)
    : undefined;

  return new VoyageEmbeddingProvider({
    apiKey,
    model: env.VOYAGE_EMBED_MODEL?.trim() || DEFAULT_VOYAGE_MODEL,
    endpoint: env.VOYAGE_API_URL?.trim() || DEFAULT_VOYAGE_ENDPOINT,
    outputDimension: Number.isFinite(outputDimension) ? outputDimension : undefined,
    timeoutMs: parseEnvInt(env.VOYAGE_TIMEOUT_MS, 10_000),
  });
}

export function encodeEmbedding(embedding: number[]): Buffer {
  const sanitized = sanitizeEmbedding(embedding);
  const floatArray = Float64Array.from(sanitized);
  return Buffer.from(floatArray.buffer.slice(0));
}

export function decodeEmbedding(blob: Buffer | Uint8Array | null | undefined): number[] | null {
  if (!blob || blob.length === 0 || blob.length % Float64Array.BYTES_PER_ELEMENT !== 0) {
    return null;
  }

  const buffer = blob instanceof Buffer ? blob : Buffer.from(blob);
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  );
  return Array.from(new Float64Array(arrayBuffer));
}

export function cosineSimilarity(a: number[], b: number[]): number | null {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return null;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let index = 0; index < a.length; index += 1) {
    const valueA = a[index];
    const valueB = b[index];
    if (valueA === undefined || valueB === undefined) {
      return null;
    }
    dot += valueA * valueB;
    normA += valueA * valueA;
    normB += valueB * valueB;
  }

  if (normA === 0 || normB === 0) {
    return null;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface RankMemoriesInput {
  memories: MemoryRecord[];
  query: string;
  limit: number;
  embeddingProvider?: EmbeddingProvider | null;
}

interface RankedMemory {
  memory: MemoryRecord;
  score: number;
  semanticScore: number;
  textScore: number;
}

export async function rankMemories(input: RankMemoriesInput): Promise<MemoryRecord[]> {
  const limit = clampInteger(input.limit, 10, 1, 100);
  const query = input.query.trim();

  if (query.length === 0) {
    return [...input.memories]
      .sort((left, right) => {
        return (
          right.importance - left.importance ||
          compareIsoDates(right.createdAt, left.createdAt) ||
          left.id.localeCompare(right.id)
        );
      })
      .slice(0, limit);
  }

  const ranked = await scoreMemories(input.memories, query, input.embeddingProvider ?? null);
  return ranked
    .filter((item) => item.score > 0)
    .sort((left, right) => {
      return (
        right.score - left.score ||
        right.semanticScore - left.semanticScore ||
        right.textScore - left.textScore ||
        right.memory.importance - left.memory.importance ||
        compareIsoDates(right.memory.createdAt, left.memory.createdAt) ||
        left.memory.id.localeCompare(right.memory.id)
      );
    })
    .slice(0, limit)
    .map((item) => item.memory);
}

async function scoreMemories(
  memories: MemoryRecord[],
  query: string,
  embeddingProvider: EmbeddingProvider | null,
): Promise<RankedMemory[]> {
  const useSemanticSearch =
    embeddingProvider !== null &&
    memories.some((memory) => Array.isArray(memory.embedding) && memory.embedding.length > 0);

  let queryEmbedding: number[] | null = null;
  if (useSemanticSearch) {
    const embeddings = await embeddingProvider.embed([query], "query");
    queryEmbedding = embeddings[0] ?? null;
  }

  return memories.map((memory) => {
    const textScore = computeTextScore(query, memory);
    const semanticScore =
      queryEmbedding && memory.embedding
        ? cosineSimilarity(queryEmbedding, memory.embedding) ?? 0
        : 0;
    const recencyScore = computeRecencyScore(memory.createdAt);
    const score = queryEmbedding
      ? semanticScore * 0.8 + Math.min(textScore, 10) * 0.12 + memory.importance * 0.05 + recencyScore * 0.03
      : textScore + memory.importance * 0.1 + recencyScore * 0.05;

    return {
      memory,
      score,
      semanticScore,
      textScore,
    };
  });
}

function computeTextScore(query: string, memory: MemoryRecord): number {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) {
    return 0;
  }

  const queryTokens = tokenize(normalizedQuery);
  const content = memory.content.toLowerCase();
  const tagSet = new Set(memory.tags.map((tag) => tag.toLowerCase()));
  let score = content.includes(normalizedQuery) ? 6 : 0;

  for (const token of queryTokens) {
    if (content.includes(token)) {
      score += 1;
    }
    if (tagSet.has(token)) {
      score += 2;
    }
  }

  return score;
}

function computeRecencyScore(createdAt: string): number {
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp)) {
    return 0;
  }

  const ageHours = Math.max((Date.now() - timestamp) / 3_600_000, 0);
  return 1 / (1 + ageHours);
}

function compareIsoDates(left: string, right: string): number {
  return Date.parse(left) - Date.parse(right);
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase();
}

function clampInteger(value: number, fallback: number, min: number, max: number): number {
  const parsed = Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(Math.max(parsed, min), max);
}

function sanitizeEmbedding(embedding: unknown[]): number[] {
  return embedding
    .map((value) => (typeof value === "number" ? value : Number(value)))
    .filter((value) => Number.isFinite(value));
}

function parseEnvInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
