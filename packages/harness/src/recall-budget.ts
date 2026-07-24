import type { Memory } from "@wappy/core";

export interface RecallBudgetOptions {
  memory: Memory;
  contactId: string;
  query: string;
  /** Hard cap on the number of snippets returned. */
  maxSnippets: number;
  /** Minimum lexical relevance (0-1, fraction of query words found in the snippet) required to keep
   * a snippet — below this, it's dropped entirely rather than counted toward maxSnippets. Default 0
   * (no filtering beyond the cap). */
  relevanceFloor?: number;
}

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

/** Fraction of the query's distinct words found in the snippet — a dependency-free relevance proxy
 * (embedding-based scoring is RAG's job, M7/M8). Empty query never matches anything. */
function lexicalRelevance(query: string, text: string): number {
  const queryWords = tokenize(query);
  if (queryWords.size === 0) return 0;
  const textWords = tokenize(text);
  let matches = 0;
  for (const w of queryWords) if (textWords.has(w)) matches++;
  return matches / queryWords.size;
}

/**
 * Wraps Memory.recall() with a snippet count cap and a relevance floor (§10 "prompt/token overflow
 * -> tool retrieval + curation"; T6.2's assembler further caps this by token budget) — never
 * returns more than `maxSnippets`, most relevant first.
 *
 * Not called anywhere in `agent.ts` itself: `AgentDeps.retrieveRag` is a caller-supplied hook whose
 * default is a no-op stub (M5 precedent — `Memory.recall` was never wired as the default RAG
 * implementation either). This function is the intended building block for a caller that DOES want
 * to implement `retrieveRag` on top of `Memory.recall` — e.g. `retrieveRag: (input) =>
 * recallWithBudget({ memory, contactId: input.contactId, query: input.query, maxSnippets: N })` —
 * left for the CLI/wiring layer (or M7/M8's real RAG work) to actually do, matching
 * `bound-tool-result.ts`'s same "built and tested, wired by its real caller later" precedent.
 */
export async function recallWithBudget(opts: RecallBudgetOptions): Promise<string[]> {
  const raw = await opts.memory.recall(opts.contactId, opts.query);
  const floor = opts.relevanceFloor ?? 0;
  return raw
    .map((text) => ({ text, score: lexicalRelevance(opts.query, text) }))
    .filter((s) => s.score >= floor)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.maxSnippets)
    .map((s) => s.text);
}
