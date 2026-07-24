import type { Client } from "@libsql/client";
import type { Memory } from "@wappy/core";
import { bm25Scores, tokenize } from "./bm25.js";
import { recallWithBudget } from "./recall-budget.js";

export interface CreateKnowledgeRagOptions {
  knowledge: Knowledge;
  topK?: number;
  scoreFloor?: number;
  /** Also recalls relevant PAST CONVERSATION turns via `Memory.recall()` (T6.4's `recallWithBudget`,
   * finally given a real caller here) and appends them after the Knowledge chunks — e.g. surfacing
   * "the user already gave us their order number earlier in this chat" alongside document knowledge.
   * Optional: omit for Knowledge-only RAG (the default — Knowledge is the module T8.3 actually asks
   * for; this is an additive complement, not a requirement). */
  memory?: Memory;
  memoryMaxSnippets?: number;
  memoryRelevanceFloor?: number;
}

/** Builds the real `AgentDeps.retrieveRag` hook (§9 Scenario B, finally wired for real in M8):
 * recalls chunks from `knowledge` and hands back their text verbatim — `agent.ts` already bounds/caps
 * everything downstream (M6), so this stays a thin adapter, not a second place that re-implements
 * bounding. An empty query or an empty/no-match store both naturally resolve to `[]` via `recall()`
 * itself (§9 "empty store -> falls back to 'I don't know', no hallucinated retrieval") — the compose
 * model, given no snippets, is the one that has to say so honestly, not this function's job. */
export function createKnowledgeRag(opts: CreateKnowledgeRagOptions): (input: { contactId: string; query: string }) => Promise<string[]> {
  return async ({ contactId, query }) => {
    if (!query) return [];
    const results = await opts.knowledge.recall(query, { topK: opts.topK, scoreFloor: opts.scoreFloor });
    const snippets = results.map((r) => r.text);
    if (!opts.memory) return snippets;
    const memorySnippets = await recallWithBudget({
      memory: opts.memory,
      contactId,
      query,
      maxSnippets: opts.memoryMaxSnippets ?? 3,
      relevanceFloor: opts.memoryRelevanceFloor,
    });
    return [...snippets, ...memorySnippets];
  };
}

export interface ChunkOptions {
  /** Target max size of a chunk, in characters. Default 800. */
  maxChunkChars?: number;
  /** Characters of the previous chunk's tail carried into the next when a paragraph itself has to
   * be split — so a fact split across a chunk boundary is still recoverable from at least one
   * chunk. Default 100 (clamped below `maxChunkChars`). */
  overlapChars?: number;
}

const DEFAULT_MAX_CHUNK_CHARS = 800;
const DEFAULT_OVERLAP_CHARS = 100;

/** Hard-slices a single "word" (no whitespace) longer than `maxChunkChars` on its own — e.g. a long
 * URL or hash with nowhere natural to break — so chunking always terminates and every piece stays
 * bounded, however pathological the input. */
function hardSlice(word: string, maxChunkChars: number): string[] {
  const pieces: string[] = [];
  for (let i = 0; i < word.length; i += maxChunkChars) pieces.push(word.slice(i, i + maxChunkChars));
  return pieces;
}

function splitLong(text: string, maxChunkChars: number, overlapChars: number): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const chunks: string[] = [];
  let current = "";
  for (const word of words) {
    if (word.length > maxChunkChars) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(...hardSlice(word, maxChunkChars));
      continue;
    }
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (candidate.length <= maxChunkChars) {
      current = candidate;
    } else {
      chunks.push(current);
      const tail = current.slice(Math.max(0, current.length - overlapChars));
      current = tail.length > 0 ? `${tail} ${word}` : word;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Splits `text` into chunks bounded by `maxChunkChars` (§8 T8.3 "ingest... chunk"): paragraphs
 * (blank-line-separated) are greedily packed together up to the limit; a single paragraph that
 * alone exceeds it is further split at word boundaries with `overlapChars` of carry-over. Empty or
 * whitespace-only input yields no chunks — never a spurious empty-string chunk.
 */
export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const maxChunkChars = opts.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS;
  const overlapChars = Math.min(opts.overlapChars ?? DEFAULT_OVERLAP_CHARS, Math.max(maxChunkChars - 1, 0));
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];

  const paragraphs = trimmed
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current.length > 0) {
      chunks.push(current);
      current = "";
    }
  };

  for (const para of paragraphs) {
    if (para.length > maxChunkChars) {
      flush();
      chunks.push(...splitLong(para, maxChunkChars, overlapChars));
      continue;
    }
    const candidate = current.length === 0 ? para : `${current}\n\n${para}`;
    if (candidate.length <= maxChunkChars) {
      current = candidate;
    } else {
      flush();
      current = para;
    }
  }
  flush();
  return chunks;
}

export interface RecalledChunk {
  id: string;
  sourceId: string;
  text: string;
  score: number;
}

export interface RecallOptions {
  /** Max chunks returned. Default 5. */
  topK?: number;
  /** A chunk must score STRICTLY above this to be recalled — the default (0) excludes a BM25 zero
   * score (no lexical overlap at all) or an orthogonal (0.0 cosine) embedding match either way, so
   * an unrelated query never drags in filler just to fill topK. */
  scoreFloor?: number;
}

export interface Knowledge {
  /** Chunks and (re)indexes `text` under `sourceId`, replacing that source's previous chunks
   * outright (a source is the unit of update — no incremental diffing in v0.1, so re-ingesting an
   * updated document never leaves stale chunks from the old version alongside the new ones).
   * Returns the number of chunks stored (0 for empty/whitespace-only text). */
  ingest(sourceId: string, text: string, chunkOptions?: ChunkOptions): Promise<number>;
  /** Removes every chunk for `sourceId`. */
  remove(sourceId: string): Promise<void>;
  /** Ranks stored chunks against `query` — by cosine similarity over stored embeddings when this
   * Knowledge was created with an `embed` function, otherwise BM25 (the default, §8 T8.3). An empty
   * store (or a query with no matches above `scoreFloor`) returns `[]`, never a hallucinated match. */
  recall(query: string, opts?: RecallOptions): Promise<RecalledChunk[]>;
}

export interface KnowledgeOptions {
  client: Client;
  /** Optional embedding provider — "via the configured model provider" (§8 T8.3) means whatever
   * embedding call the caller's own model setup provides (e.g. the Vercel AI SDK's `embedMany`),
   * wired in here as a plain function so this module stays provider-agnostic (hub-and-spoke: no
   * provider SDK imported here). Embeddings are computed once at ingest time and stored, not
   * recomputed on every `recall()`. Unset (the default): BM25 only, no embedding computation at all. */
  embed?: (texts: string[]) => Promise<number[][]>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id TEXT PRIMARY KEY,
  sourceId TEXT NOT NULL,
  chunkIndex INTEGER NOT NULL,
  text TEXT NOT NULL,
  embedding TEXT
);
CREATE INDEX IF NOT EXISTS idx_knowledge_source ON knowledge_chunks(sourceId);
`;

const DEFAULT_TOP_K = 5;
const DEFAULT_SCORE_FLOOR = 0;

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * (b[i] ?? 0);
    normA += a[i]! * a[i]!;
  }
  for (let i = 0; i < b.length; i++) normB += b[i]! * b[i]!;
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

interface KnowledgeRow {
  id: string;
  sourceId: string;
  text: string;
  embedding: string | null;
}

/** LibSQL-backed Knowledge store (§8 T8.3, "local store (LibSQL)"). Lexical (BM25) by default,
 * matching M6/T6.5's own tool-selector so the codebase has one relevance-ranking approach, not two;
 * an optional `embed` function switches `recall()` to cosine similarity over stored embeddings.
 */
export function createKnowledge(opts: KnowledgeOptions): Knowledge {
  const client = opts.client;
  let ready: Promise<void> | undefined;
  const ensureSchema = (): Promise<void> => {
    if (!ready) {
      ready = client.executeMultiple(SCHEMA).catch((e: unknown) => {
        ready = undefined; // let the next call retry instead of permanently caching a transient failure
        throw e;
      });
    }
    return ready;
  };

  return {
    async ingest(sourceId, text, chunkOptions) {
      await ensureSchema();
      await client.execute({ sql: "DELETE FROM knowledge_chunks WHERE sourceId = ?", args: [sourceId] });
      const pieces = chunkText(text, chunkOptions);
      if (pieces.length === 0) return 0;

      const embeddings = opts.embed ? await opts.embed(pieces) : undefined;
      await client.batch(
        pieces.map((piece, i) => ({
          sql: "INSERT INTO knowledge_chunks (id, sourceId, chunkIndex, text, embedding) VALUES (?, ?, ?, ?, ?)",
          args: [`${sourceId}:${i}`, sourceId, i, piece, embeddings ? JSON.stringify(embeddings[i]) : null],
        })),
        "write",
      );
      return pieces.length;
    },

    async remove(sourceId) {
      await ensureSchema();
      await client.execute({ sql: "DELETE FROM knowledge_chunks WHERE sourceId = ?", args: [sourceId] });
    },

    async recall(query, recallOpts) {
      await ensureSchema();
      const topK = recallOpts?.topK ?? DEFAULT_TOP_K;
      const scoreFloor = recallOpts?.scoreFloor ?? DEFAULT_SCORE_FLOOR;

      const result = await client.execute("SELECT id, sourceId, text, embedding FROM knowledge_chunks");
      const rows = result.rows as unknown as KnowledgeRow[];
      if (rows.length === 0) return [];

      if (opts.embed) {
        const [queryEmbedding] = await opts.embed([query]);
        const embedded = rows.filter((r): r is KnowledgeRow & { embedding: string } => r.embedding !== null);
        const scored = embedded
          .map((row) => ({ row, score: queryEmbedding ? cosineSimilarity(queryEmbedding, JSON.parse(row.embedding) as number[]) : 0 }))
          .filter((s) => s.score > scoreFloor)
          .sort((a, b) => b.score - a.score)
          .slice(0, topK);
        return scored.map((s) => ({ id: s.row.id, sourceId: s.row.sourceId, text: s.row.text, score: s.score }));
      }

      const queryTerms = tokenize(query);
      const docs = rows.map((r) => tokenize(r.text));
      const scores = bm25Scores(queryTerms, docs);
      return rows
        .map((row, i) => ({ row, score: scores[i]! }))
        .filter((s) => s.score > scoreFloor)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)
        .map((s) => ({ id: s.row.id, sourceId: s.row.sourceId, text: s.row.text, score: s.score }));
    },
  };
}
