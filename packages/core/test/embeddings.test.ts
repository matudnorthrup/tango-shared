import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cosineSimilarity,
  createDeterministicEmbeddingProvider,
  deserializeEmbedding,
  serializeEmbedding,
  VoyageEmbeddingProvider,
} from "../src/embeddings.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("embeddings", () => {
  it("serializes and deserializes embeddings losslessly", () => {
    const serialized = serializeEmbedding([0.1, 0.2, 0.3]);
    expect(deserializeEmbedding(serialized)).toEqual([0.1, 0.2, 0.3]);
  });

  it("computes cosine similarity for aligned vectors", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("builds deterministic test embeddings", async () => {
    const provider = createDeterministicEmbeddingProvider(16);
    const first = await provider.embed(["weekly cadence"], "query");
    const second = await provider.embed(["weekly cadence"], "query");
    const different = await provider.embed(["lunch logging"], "query");

    expect(first[0]).toEqual(second[0]);
    expect(first[0]).not.toEqual(different[0]);
  });

  it("calls Voyage embeddings with the expected payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ embedding: [0.25, 0.75] }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new VoyageEmbeddingProvider({
      apiKey: "test-key",
      model: "voyage-4-lite",
      endpoint: "https://api.voyageai.test/v1/embeddings",
      timeoutMs: 5_000,
    });

    const result = await provider.embed(["hello world"], "query");
    expect(result).toEqual([[0.25, 0.75]]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.voyageai.test/v1/embeddings",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-key",
          "Content-Type": "application/json",
        }),
      })
    );

    const body = JSON.parse((fetchMock.mock.calls[0] ?? [])[1]?.body as string);
    expect(body).toMatchObject({
      input: "hello world",
      model: "voyage-4-lite",
      input_type: "query",
    });
  });
});
