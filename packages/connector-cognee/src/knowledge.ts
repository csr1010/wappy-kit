import type { ChunkOptions, Knowledge, RecallOptions, RecalledChunk } from "@wappy_ai/harness";
import { createCogneeClient, type CogneeClientOptions, type CogneeSearchResult } from "./client.js";

/**
 * A real `Knowledge` implementation backed by Cognee instead of `@wappy_ai/harness`'s own local
 * (LibSQL/BM25) one — same interface, different backend, following the exact "pluggable, no change
 * to the consuming code" pattern `Knowledge` was already designed for. Cognee's real model (a
 * self-hosted or cloud knowledge-graph service — extracts entities/relationships, described as
 * self-correcting over repeated ingests) is a natural fit for this interface's `ingest`/`recall`
 * shape, unlike `@wappy_ai/core`'s `Memory` (raw per-contact turn history, which this package
 * deliberately does NOT touch — see the plan this was built from).
 */
export type CogneeKnowledgeOptions = CogneeClientOptions;

/** Cognee's real per-result "which dataset did this come from" field name isn't confirmed (see
 * client.ts's honest-unknown note) — checks the plausible candidates and falls back to a generic
 * label rather than silently mislabeling every result as a fixed sourceId. */
function toRecalledChunk(index: number, result: CogneeSearchResult): RecalledChunk {
  const sourceId =
    (typeof result.datasetName === "string" && result.datasetName) ||
    (typeof result.sourceId === "string" && result.sourceId) ||
    (typeof result.source === "string" && result.source) ||
    "cognee";
  return {
    id: typeof result.id === "string" ? result.id : `${sourceId}:${index}`,
    sourceId,
    text: typeof result.text === "string" ? result.text : JSON.stringify(result),
    score: typeof result.score === "number" ? result.score : 0,
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
        .filter((chunk) => chunk.score > scoreFloor);
    },
  };
}
