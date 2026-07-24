import { describe, expect, test } from "vitest";
import { createClient } from "@libsql/client";
import { createKnowledge } from "./knowledge.js";

/**
 * LibSQL-native vector storage (M14): when `embedDimensions` is supplied alongside `embed`,
 * `createKnowledge` stores embeddings in a real `F32_BLOB(N)` column with a `libsql_vector_idx`
 * ANN index, and `recall()` ranks via `vector_distance_cos` in SQL instead of loading every row
 * into JS and computing cosine similarity by hand (the existing, unchanged `embed`-without-
 * `embedDimensions` path, covered by `knowledge.m8.test.ts` — untouched by this addition).
 */
function memClient() {
  return createClient({ url: ":memory:" });
}

function fakeEmbed(vectors: Record<string, number[]>) {
  return async (texts: string[]): Promise<number[][]> => texts.map((t) => vectors[t] ?? []);
}

describe("createKnowledge — embedDimensions (LibSQL-native vector storage)", () => {
  test("recall ranks by cosine similarity via the native vector index, same RecalledChunk shape as the JS-side path", async () => {
    const vectors = { "about candles": [1, 0, 0], "about shipping": [0, 1, 0], "candle question": [1, 0, 0] };
    const k = createKnowledge({ client: memClient(), embed: fakeEmbed(vectors), embedDimensions: 3 });
    await k.ingest("doc1", "about candles");
    await k.ingest("doc2", "about shipping");

    // scoreFloor: -1 — the default floor (0) would correctly exclude doc2's exact-0 orthogonal
    // score (score must be STRICTLY above the floor, same rule as the BM25/JS-embedding paths); this
    // test wants to see both ranked results, so it explicitly widens the floor.
    const results = await k.recall("candle question", { scoreFloor: -1 });
    expect(results[0]?.sourceId).toBe("doc1");
    expect(results[0]?.score).toBeCloseTo(1, 5); // identical direction -> cosine similarity 1
    expect(results[1]?.sourceId).toBe("doc2");
    expect(results[1]?.score).toBeCloseTo(0, 5); // orthogonal -> 0
  });

  test("scoreFloor still excludes low-similarity chunks", async () => {
    const vectors = { "same direction": [1, 0], "opposite direction": [-1, 0], query: [1, 0] };
    const k = createKnowledge({ client: memClient(), embed: fakeEmbed(vectors), embedDimensions: 2 });
    await k.ingest("same", "same direction");
    await k.ingest("opposite", "opposite direction");

    const results = await k.recall("query", { scoreFloor: 0 });
    expect(results.map((r) => r.sourceId)).toEqual(["same"]); // opposite direction scores -1, excluded
  });

  test("topK is respected", async () => {
    const vectors: Record<string, number[]> = {};
    for (let i = 0; i < 10; i++) vectors[`doc ${i}`] = [1, i]; // all similar-ish, none identical
    vectors.query = [1, 0];
    const k = createKnowledge({ client: memClient(), embed: fakeEmbed(vectors), embedDimensions: 2 });
    for (let i = 0; i < 10; i++) await k.ingest(`s${i}`, `doc ${i}`);

    const results = await k.recall("query", { topK: 3 });
    expect(results).toHaveLength(3);
  });

  test("an embed() call returning no vector for the query has nothing honest to rank against — returns [], not an arbitrary/crashed result", async () => {
    const embed = async (texts: string[]): Promise<number[][]> => (texts[0] === "a query" ? [] : texts.map(() => [1, 0]));
    const k = createKnowledge({ client: memClient(), embed, embedDimensions: 2 });
    await k.ingest("doc", "some text");
    expect(await k.recall("a query")).toEqual([]);
  });

  test("an empty store returns [], never a crash querying an index with zero rows", async () => {
    const k = createKnowledge({ client: memClient(), embed: fakeEmbed({}), embedDimensions: 3 });
    expect(await k.recall("anything")).toEqual([]);
  });

  test("remove() deletes a source's chunks from the vector-backed table too", async () => {
    const vectors = { "keep me": [1, 0], "delete me": [0, 1], query: [1, 0] };
    const k = createKnowledge({ client: memClient(), embed: fakeEmbed(vectors), embedDimensions: 2 });
    await k.ingest("keep", "keep me");
    await k.ingest("gone", "delete me");
    await k.remove("gone");
    const results = await k.recall("query", { topK: 10, scoreFloor: -1 });
    expect(results.map((r) => r.sourceId)).toEqual(["keep"]);
  });

  test("re-ingesting a source replaces its previous chunks/vectors, not append to them", async () => {
    const vectors = { "old text": [1, 0], "new text": [0, 1], query: [0, 1] };
    const k = createKnowledge({ client: memClient(), embed: fakeEmbed(vectors), embedDimensions: 2 });
    await k.ingest("doc", "old text");
    await k.ingest("doc", "new text");
    const results = await k.recall("query", { topK: 10, scoreFloor: -1 });
    expect(results).toHaveLength(1);
    expect(results[0]?.text).toBe("new text");
  });

  test("without embedDimensions, embed-only still uses the original JS brute-force cosine path (unchanged, backward compatible)", async () => {
    // Not a behavioral assertion beyond what knowledge.m8.test.ts already covers — just confirms
    // omitting embedDimensions doesn't require it (the parameter is genuinely optional).
    const vectors = { a: [1, 0], b: [1, 0] };
    const k = createKnowledge({ client: memClient(), embed: fakeEmbed(vectors) });
    await k.ingest("doc", "a");
    const results = await k.recall("b");
    expect(results).toHaveLength(1);
  });
});
