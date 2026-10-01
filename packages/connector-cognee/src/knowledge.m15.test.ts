import { describe, expect, test, vi } from "vitest";
import { createCogneeKnowledge } from "./knowledge.js";

/** M15 (plan: "Memory backend — local vs. Cognee"). Confirms createCogneeKnowledge satisfies the
 * real Knowledge interface shape against an injected fake fetch — never real network. */

function fakeFetch(responses: unknown[]) {
  const queue = [...responses];
  return vi.fn(async () => {
    const response = queue.shift();
    return { ok: true, status: 200, statusText: "", text: async () => JSON.stringify(response ?? {}) } as unknown as Response;
  });
}

describe("createCogneeKnowledge — ingest", () => {
  test("calls add() then cognify() for the given sourceId, in order", async () => {
    const fetchImpl = fakeFetch([{}, {}]);
    const knowledge = createCogneeKnowledge({ baseUrl: "http://localhost:8000", fetchImpl });
    await knowledge.ingest("doc-1", "some real text to ingest");
    expect(fetchImpl.mock.calls).toHaveLength(2);
    expect(String(fetchImpl.mock.calls[0]![0])).toContain("/api/v1/add");
    expect(String(fetchImpl.mock.calls[1]![0])).toContain("/api/v1/cognify");
  });

  test("empty/whitespace-only text is a no-op — never calls the API, returns 0", async () => {
    const fetchImpl = fakeFetch([]);
    const knowledge = createCogneeKnowledge({ baseUrl: "http://localhost:8000", fetchImpl });
    const count = await knowledge.ingest("doc-1", "   ");
    expect(count).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("a real ingest returns 1 (one source ingested — not a literal chunk count, see knowledge.ts's own comment)", async () => {
    const fetchImpl = fakeFetch([{}, {}]);
    const knowledge = createCogneeKnowledge({ baseUrl: "http://localhost:8000", fetchImpl });
    const count = await knowledge.ingest("doc-1", "real text");
    expect(count).toBe(1);
  });

  test("chunkOptions is accepted (matches the Knowledge interface) but doesn't change the request — Cognee does its own chunking", async () => {
    const fetchImpl = fakeFetch([{}, {}]);
    const knowledge = createCogneeKnowledge({ baseUrl: "http://localhost:8000", fetchImpl });
    await knowledge.ingest("doc-1", "real text", { maxChunkChars: 50, overlapChars: 5 });
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as { body: string }).body);
    expect(body).not.toHaveProperty("maxChunkChars");
    expect(body).not.toHaveProperty("overlapChars");
  });
});

describe("createCogneeKnowledge — remove", () => {
  test("calls removeDataset() with the sourceId", async () => {
    const fetchImpl = fakeFetch([{}]);
    const knowledge = createCogneeKnowledge({ baseUrl: "http://localhost:8000", fetchImpl });
    await knowledge.remove("doc-1");
    expect(String(fetchImpl.mock.calls[0]![0])).toContain("/api/v1/datasets");
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as { body: string }).body);
    expect(body.datasetName).toBe("doc-1");
  });
});

describe("createCogneeKnowledge — recall", () => {
  test("maps a search response into RecalledChunk[] with id/sourceId/text/score", async () => {
    const fetchImpl = fakeFetch([[{ id: "r1", text: "a matching chunk", score: 0.8, datasetName: "doc-1" }]]);
    const knowledge = createCogneeKnowledge({ baseUrl: "http://localhost:8000", fetchImpl });
    const chunks = await knowledge.recall("query");
    expect(chunks).toEqual([{ id: "r1", sourceId: "doc-1", text: "a matching chunk", score: 0.8 }]);
  });

  test("falls back to a generic sourceId when the response doesn't name one", async () => {
    const fetchImpl = fakeFetch([[{ id: "r1", text: "a matching chunk", score: 0.8 }]]);
    const knowledge = createCogneeKnowledge({ baseUrl: "http://localhost:8000", fetchImpl });
    const chunks = await knowledge.recall("query");
    expect(chunks[0]!.sourceId).toBe("cognee");
  });

  test("falls back to result.sourceId when datasetName isn't present", async () => {
    const fetchImpl = fakeFetch([[{ id: "r1", text: "x", score: 0.5, sourceId: "from-sourceId-field" }]]);
    const knowledge = createCogneeKnowledge({ baseUrl: "http://localhost:8000", fetchImpl });
    const chunks = await knowledge.recall("query");
    expect(chunks[0]!.sourceId).toBe("from-sourceId-field");
  });

  test("falls back to result.source when neither datasetName nor sourceId are present", async () => {
    const fetchImpl = fakeFetch([[{ id: "r1", text: "x", score: 0.5, source: "from-source-field" }]]);
    const knowledge = createCogneeKnowledge({ baseUrl: "http://localhost:8000", fetchImpl });
    const chunks = await knowledge.recall("query");
    expect(chunks[0]!.sourceId).toBe("from-source-field");
  });

  test("a result missing text falls back to a stringified JSON representation, not undefined", async () => {
    const fetchImpl = fakeFetch([[{ id: "r1", score: 0.5, somethingElse: "x" }]]);
    const knowledge = createCogneeKnowledge({ baseUrl: "http://localhost:8000", fetchImpl });
    const chunks = await knowledge.recall("query");
    expect(chunks[0]!.text).toContain("somethingElse");
  });

  test("a result missing a numeric score defaults to 0", async () => {
    const fetchImpl = fakeFetch([[{ id: "r1", text: "x" }]]);
    const knowledge = createCogneeKnowledge({ baseUrl: "http://localhost:8000", fetchImpl });
    const chunks = await knowledge.recall("query", { scoreFloor: -1 }); // allow a 0-score chunk through
    expect(chunks[0]!.score).toBe(0);
  });

  test("a result missing an id gets a generated one from its sourceId and index", async () => {
    const fetchImpl = fakeFetch([[{ text: "no id here", score: 0.5 }]]);
    const knowledge = createCogneeKnowledge({ baseUrl: "http://localhost:8000", fetchImpl });
    const chunks = await knowledge.recall("query");
    expect(chunks[0]!.id).toBe("cognee:0");
  });

  test("respects scoreFloor — excludes a chunk at or below the floor", async () => {
    const fetchImpl = fakeFetch([
      [
        { id: "r1", text: "low score", score: 0 },
        { id: "r2", text: "high score", score: 0.9 },
      ],
    ]);
    const knowledge = createCogneeKnowledge({ baseUrl: "http://localhost:8000", fetchImpl });
    const chunks = await knowledge.recall("query", { scoreFloor: 0 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.id).toBe("r2");
  });

  test("passes topK through to the search request", async () => {
    const fetchImpl = fakeFetch([[]]);
    const knowledge = createCogneeKnowledge({ baseUrl: "http://localhost:8000", fetchImpl });
    await knowledge.recall("query", { topK: 2 });
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as { body: string }).body);
    expect(body.topK).toBe(2);
  });

  test("an empty result is an honest empty array, not a hallucinated match", async () => {
    const fetchImpl = fakeFetch([[]]);
    const knowledge = createCogneeKnowledge({ baseUrl: "http://localhost:8000", fetchImpl });
    const chunks = await knowledge.recall("nothing matches this");
    expect(chunks).toEqual([]);
  });
});
