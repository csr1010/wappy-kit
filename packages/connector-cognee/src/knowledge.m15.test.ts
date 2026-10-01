import { describe, expect, test, vi } from "vitest";
import { createCogneeKnowledge } from "./knowledge.js";

/** M15 (plan: "Memory backend — local vs. Cognee"). Confirms createCogneeKnowledge satisfies the
 * real Knowledge interface shape against an injected fake fetch — never real network. The response
 * shapes mapped here (document_id/document_name, not a datasetName field) were confirmed against a
 * real, locally-booted Cognee server (ingest → cognify → CHUNKS search → real response read back),
 * see client.ts's and knowledge.ts's own doc comments. */

function fakeFetch(responses: unknown[]) {
  const queue = [...responses];
  return vi.fn(async () => {
    const response = queue.shift();
    return { ok: true, status: 200, statusText: "", text: async () => JSON.stringify(response ?? {}) } as unknown as Response;
  });
}

describe("createCogneeKnowledge — ingest", () => {
  test("on a fresh sourceId: looks up (finds nothing), then calls add() and cognify(), in order", async () => {
    const fetchImpl = fakeFetch([[], {}, {}]); // GET /datasets -> no match, then add, then cognify
    const knowledge = createCogneeKnowledge({ baseUrl: "http://localhost:8000", fetchImpl });
    await knowledge.ingest("doc-1", "some real text to ingest");
    expect(fetchImpl.mock.calls).toHaveLength(3);
    expect(String(fetchImpl.mock.calls[0]![0])).toContain("/api/v1/datasets");
    expect(String(fetchImpl.mock.calls[1]![0])).toContain("/api/v1/add");
    expect(String(fetchImpl.mock.calls[2]![0])).toContain("/api/v1/cognify");
  });

  test("ingesting a SECOND time under the same sourceId REPLACES the prior content, it does not accrete alongside it — matches the contract @wappy_ai/harness's own local Knowledge already enforces (it deletes a sourceId's old chunks before inserting new ones)", async () => {
    const fetchImpl = fakeFetch([[{ id: "uuid-old", name: "doc-1" }], {}, {}, {}]); // GET /datasets -> finds the old one, DELETE it, then add, then cognify
    const knowledge = createCogneeKnowledge({ baseUrl: "http://localhost:8000", fetchImpl });
    await knowledge.ingest("doc-1", "updated text, supersedes the old version");
    expect(fetchImpl.mock.calls).toHaveLength(4);
    expect(String(fetchImpl.mock.calls[0]![0])).toContain("/api/v1/datasets");
    expect((fetchImpl.mock.calls[0]![1] as { method: string })?.method).toBe("GET");
    expect(String(fetchImpl.mock.calls[1]![0])).toBe("http://localhost:8000/api/v1/datasets/uuid-old");
    expect((fetchImpl.mock.calls[1]![1] as { method: string }).method).toBe("DELETE");
    expect(String(fetchImpl.mock.calls[2]![0])).toContain("/api/v1/add");
    expect(String(fetchImpl.mock.calls[3]![0])).toContain("/api/v1/cognify");
  });

  test("empty/whitespace-only text is a no-op — never calls the API, returns 0", async () => {
    const fetchImpl = fakeFetch([]);
    const knowledge = createCogneeKnowledge({ baseUrl: "http://localhost:8000", fetchImpl });
    const count = await knowledge.ingest("doc-1", "   ");
    expect(count).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("a real ingest returns 1 (one source ingested — not a literal chunk count, see knowledge.ts's own comment)", async () => {
    const fetchImpl = fakeFetch([[], {}, {}]);
    const knowledge = createCogneeKnowledge({ baseUrl: "http://localhost:8000", fetchImpl });
    const count = await knowledge.ingest("doc-1", "real text");
    expect(count).toBe(1);
  });

  test("chunkOptions is accepted (matches the Knowledge interface) but doesn't change the request — Cognee does its own chunking", async () => {
    const fetchImpl = fakeFetch([[], {}, {}]);
    const knowledge = createCogneeKnowledge({ baseUrl: "http://localhost:8000", fetchImpl });
    await knowledge.ingest("doc-1", "real text", { maxChunkChars: 50, overlapChars: 5 });
    const body = (fetchImpl.mock.calls[1]![1] as { body: FormData }).body;
    expect(body.has("maxChunkChars")).toBe(false);
    expect(body.has("overlapChars")).toBe(false);
  });
});

describe("createCogneeKnowledge — remove", () => {
  test("calls removeDataset() with the sourceId", async () => {
    const fetchImpl = fakeFetch([[{ id: "uuid-1", name: "doc-1" }], {}]);
    const knowledge = createCogneeKnowledge({ baseUrl: "http://localhost:8000", fetchImpl });
    await knowledge.remove("doc-1");
    expect(String(fetchImpl.mock.calls[0]![0])).toContain("/api/v1/datasets");
    expect(String(fetchImpl.mock.calls[1]![0])).toContain("/api/v1/datasets/uuid-1");
  });
});

describe("createCogneeKnowledge — recall", () => {
  test("maps a real CHUNKS search response into RecalledChunk[], inverting Cognee's raw distance into a similarity score", async () => {
    // Confirmed live (see knowledge.ts's own comment): Cognee's CHUNKS `score` is a distance
    // (lower = closer match), the opposite of this interface's own "higher = better" convention —
    // a raw 0.2 (a close match) must come back as RecalledChunk.score 0.8, not 0.2.
    const fetchImpl = fakeFetch([[{ id: "c1", text: "a matching chunk", score: 0.2, document_id: "doc-uuid-1", document_name: "text_abc" }]]);
    const knowledge = createCogneeKnowledge({ baseUrl: "http://localhost:8000", fetchImpl });
    const chunks = await knowledge.recall("query");
    expect(chunks).toEqual([{ id: "c1", sourceId: "doc-uuid-1", text: "a matching chunk", score: 0.8 }]);
  });

  test("falls back to a generic sourceId when the response doesn't name a document_id — confirmed live: there is no field that round-trips the original ingest() sourceId", async () => {
    const fetchImpl = fakeFetch([[{ id: "c1", text: "a matching chunk", score: 0.2 }]]);
    const knowledge = createCogneeKnowledge({ baseUrl: "http://localhost:8000", fetchImpl });
    const chunks = await knowledge.recall("query");
    expect(chunks[0]!.sourceId).toBe("cognee");
  });

  test("a result missing text falls back to a stringified JSON representation, not undefined", async () => {
    const fetchImpl = fakeFetch([[{ id: "c1", score: 0.5, somethingElse: "x" }]]);
    const knowledge = createCogneeKnowledge({ baseUrl: "http://localhost:8000", fetchImpl });
    const chunks = await knowledge.recall("query");
    expect(chunks[0]!.text).toContain("somethingElse");
  });

  test("a result missing a numeric score defaults to 0 (no distance to invert)", async () => {
    const fetchImpl = fakeFetch([[{ id: "c1", text: "x" }]]);
    const knowledge = createCogneeKnowledge({ baseUrl: "http://localhost:8000", fetchImpl });
    const chunks = await knowledge.recall("query", { scoreFloor: -1 }); // allow a 0-score chunk through
    expect(chunks[0]!.score).toBe(0);
  });

  test("a result missing an id gets a generated one from its sourceId and index", async () => {
    const fetchImpl = fakeFetch([[{ text: "no id here", score: 0.5, document_id: "doc-1" }]]);
    const knowledge = createCogneeKnowledge({ baseUrl: "http://localhost:8000", fetchImpl });
    const chunks = await knowledge.recall("query");
    expect(chunks[0]!.id).toBe("doc-1:0");
  });

  test("respects scoreFloor — excludes a chunk at or below the floor, using the inverted (similarity) score", async () => {
    const fetchImpl = fakeFetch([
      [
        { id: "c1", text: "far / bad match", score: 1 }, // distance 1 → similarity 0, excluded by floor 0
        { id: "c2", text: "close / good match", score: 0.1 }, // distance 0.1 → similarity 0.9, kept
      ],
    ]);
    const knowledge = createCogneeKnowledge({ baseUrl: "http://localhost:8000", fetchImpl });
    const chunks = await knowledge.recall("query", { scoreFloor: 0 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.id).toBe("c2");
  });

  test("sorts by (inverted) score descending — best match first, regardless of the raw distance order Cognee returned them in", async () => {
    const fetchImpl = fakeFetch([
      [
        { id: "far", text: "far", score: 0.8 }, // similarity 0.2
        { id: "close", text: "close", score: 0.1 }, // similarity 0.9
        { id: "medium", text: "medium", score: 0.5 }, // similarity 0.5
      ],
    ]);
    const knowledge = createCogneeKnowledge({ baseUrl: "http://localhost:8000", fetchImpl });
    const chunks = await knowledge.recall("query");
    expect(chunks.map((c) => c.id)).toEqual(["close", "medium", "far"]);
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
