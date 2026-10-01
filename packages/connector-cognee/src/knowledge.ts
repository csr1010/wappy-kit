import type { ChunkOptions, Knowledge, RecallOptions, RecalledChunk } from "@wappy_ai/harness";
import { createCogneeClient, type CogneeChunk, type CogneeClientOptions } from "./client.js";

/**
 * A real `Knowledge` implementation backed by Cognee instead of `@wappy_ai/harness`'s own local
 * (LibSQL/BM25) one — same interface, different backend, following the exact "pluggable, no change
 * to the consuming code" pattern `Knowledge` was already designed for. Cognee's real model (a
 * self-hosted or cloud knowledge-graph service — extracts entities/relationships, described as
 * self-correcting over repeated ingests) is a natural fit for this interface's `ingest`/`recall`
 * shape, unlike `@wappy_ai/core`'s `Memory` (raw per-contact turn history, which this package
 * deliberately does NOT touch — see the plan this was built from).
 *
 * The response mapping below was confirmed against a real, locally-booted Cognee server (ingest a
 * sentence, cognify it, search for it, read back the exact `{id, text, score, document_id,
 * document_name}` shape) — see client.ts's own module doc comment for the full confirmed contract.
 */
export type CogneeKnowledgeOptions = CogneeClientOptions;

function toRecalledChunk(index: number, chunk: CogneeChunk): RecalledChunk {
  // Confirmed live: a CHUNKS search result carries `document_id`/`document_name`, not the dataset
  // name it was ingested under — there is no field in the real response that round-trips the
  // `sourceId` passed to `ingest()`. `document_id` is the closest stable identifier Cognee actually
  // returns, so it's used here; it won't equal the original `sourceId`, by design, not by bug.
  const sourceId = typeof chunk.document_id === "string" ? chunk.document_id : "cognee";
  // Confirmed live, and the opposite of what the field name suggests: Cognee's CHUNKS `score` is a
  // vector DISTANCE (lower = closer match) — verified by ingesting 3 distinct facts and querying
  // each; in every case the obviously-correct chunk came back with the LOWEST score, not the
  // highest. `@wappy_ai/harness`'s own local vector path already normalizes this exact way
  // (`score: 1 - r.dist`, see its knowledge.ts) — mirrored here so `scoreFloor`/sorting behave the
  // same (higher = better) regardless of which Knowledge backend is plugged in.
  const score = typeof chunk.score === "number" ? 1 - chunk.score : 0;
  return {
    id: typeof chunk.id === "string" ? chunk.id : `${sourceId}:${index}`,
    sourceId,
    text: typeof chunk.text === "string" ? chunk.text : JSON.stringify(chunk),
    score,
  };
}

export function createCogneeKnowledge(opts: CogneeKnowledgeOptions): Knowledge {
  const client = createCogneeClient(opts);

  return {
    // `chunkOptions` (maxChunkChars/overlapChars) has no server-side analog here — Cognee does its
    // own chunking/extraction as part of `cognify()`, so a caller-specified chunk size can't be
    // honored. Deliberately ignored, not silently misapplied, and documented here rather than
    // pretending to support it.
    async ingest(sourceId: string, text: string, chunkOptions?: ChunkOptions): Promise<number> {
      void chunkOptions; // intentionally unused — see the comment above
      if (!text.trim()) return 0;
      await client.add(sourceId, text);
      await client.cognify(sourceId);
      // Cognee's cognify response doesn't give a confirmed "chunk count" equivalent (see client.ts's
      // own honest-unknown note) — `1` honestly means "one source successfully ingested," not a
      // literal chunk count the way the local BM25 implementation's return value is.
      return 1;
    },

    async remove(sourceId: string): Promise<void> {
      await client.removeDataset(sourceId);
    },

    async recall(query: string, opts?: RecallOptions): Promise<RecalledChunk[]> {
      const results = await client.search(query, opts?.topK);
      const scoreFloor = opts?.scoreFloor ?? 0;
      return results
        .map((r, i) => toRecalledChunk(i, r))
        .filter((chunk) => chunk.score > scoreFloor)
        .sort((a, b) => b.score - a.score);
    },
  };
}
