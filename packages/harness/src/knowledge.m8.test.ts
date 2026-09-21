import { describe, expect, test } from "vitest";
import { createClient } from "@libsql/client";
import type { Memory } from "@wappy/core";
import { chunkText, createKnowledge, createKnowledgeRag } from "./knowledge.js";

function memClient() {
  return createClient({ url: ":memory:" });
}

describe("chunkText — edge cases", () => {
  test("empty string yields no chunks", () => {
    expect(chunkText("")).toEqual([]);
  });

  test("whitespace-only string yields no chunks", () => {
    expect(chunkText("   \n\n\t  ")).toEqual([]);
  });

  test("short text under the limit is a single chunk", () => {
    expect(chunkText("Our store is open 9-5 Monday to Friday.", { maxChunkChars: 800 })).toEqual(["Our store is open 9-5 Monday to Friday."]);
  });

  test("multiple short paragraphs are packed together up to the limit", () => {
    const text = "Para one.\n\nPara two.\n\nPara three.";
    const chunks = chunkText(text, { maxChunkChars: 800 });
    expect(chunks).toEqual(["Para one.\n\nPara two.\n\nPara three."]);
  });

  test("a paragraph exceeding the limit is split at word boundaries", () => {
    const para = Array.from({ length: 50 }, (_, i) => `word${i}`).join(" "); // well over 100 chars
    const chunks = chunkText(para, { maxChunkChars: 100, overlapChars: 10 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
    // every original word is still recoverable somewhere in the output
    expect(chunks.join(" ")).toContain("word0");
    expect(chunks.join(" ")).toContain("word49");
  });

  test("a single 'word' longer than the limit (e.g. a long URL) is hard-sliced, never infinite-loops", () => {
    const longWord = "https://example.com/" + "a".repeat(500);
    const chunks = chunkText(longWord, { maxChunkChars: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
    expect(chunks.join("")).toBe(longWord);
  });

  test("chunks never exceed maxChunkChars across a realistic mixed document", () => {
    const paragraphs = [
      "Short intro.",
      "A medium-length paragraph ".repeat(10),
      "A very long paragraph that goes on and on ".repeat(30),
      "Another short one.",
    ];
    const chunks = chunkText(paragraphs.join("\n\n"), { maxChunkChars: 200, overlapChars: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(200);
  });
});

describe("createKnowledge — BM25 (default) recall", () => {
  test("ingest then recall finds a lexically relevant chunk", async () => {
    const k = createKnowledge({ client: memClient() });
    await k.ingest("hours", "Our store hours are 9am to 5pm, Monday through Friday. Closed on public holidays.");
    const results = await k.recall("what are your store hours");
    expect(results.length).toBe(1);
    expect(results[0]!.text).toContain("9am to 5pm");
    expect(results[0]!.sourceId).toBe("hours");
    expect(results[0]!.score).toBeGreaterThan(0);
  });

  test("an empty store returns no results — no hallucinated retrieval", async () => {
    const k = createKnowledge({ client: memClient() });
    const results = await k.recall("anything at all");
    expect(results).toEqual([]);
  });

  test("a query with zero lexical overlap returns no results, not the nearest-worst match", async () => {
    const k = createKnowledge({ client: memClient() });
    await k.ingest("hours", "We're open 9am to 5pm Monday through Friday.");
    const results = await k.recall("xyzzyplugh quux wombat");
    expect(results).toEqual([]);
  });

  test("topK caps the number of recalled chunks, best-scoring first", async () => {
    const k = createKnowledge({ client: memClient() });
    for (let i = 0; i < 5; i++) await k.ingest(`doc${i}`, `This document talks about shipping and returns, case ${i}.`);
    const results = await k.recall("shipping returns", { topK: 2 });
    expect(results.length).toBe(2);
    expect(results[0]!.score).toBeGreaterThanOrEqual(results[1]!.score);
  });

  test("scoreFloor excludes weakly-matching chunks", async () => {
    const k = createKnowledge({ client: memClient() });
    await k.ingest("a", "shipping and returns policy details here");
    await k.ingest("b", "our return window is thirty days for shipping-related issues");
    const permissive = await k.recall("shipping returns policy");
    const strict = await k.recall("shipping returns policy", { scoreFloor: 1000 });
    expect(permissive.length).toBeGreaterThan(0);
    expect(strict).toEqual([]);
  });

  test("re-ingesting the same sourceId replaces its previous chunks, not adds to them", async () => {
    const k = createKnowledge({ client: memClient() });
    await k.ingest("policy", "Old policy: returns within 7 days.");
    await k.ingest("policy", "New policy: returns within 30 days.");
    const results = await k.recall("policy returns days", { topK: 10 });
    const texts = results.map((r) => r.text);
    expect(texts.some((t) => t.includes("30 days"))).toBe(true);
    expect(texts.some((t) => t.includes("7 days"))).toBe(false);
  });

  test("remove() deletes a source's chunks entirely", async () => {
    const k = createKnowledge({ client: memClient() });
    await k.ingest("temp", "This is a temporary document about widgets.");
    await k.remove("temp");
    const results = await k.recall("widgets");
    expect(results).toEqual([]);
  });

  test("ingest returns the chunk count, 0 for empty text", async () => {
    const k = createKnowledge({ client: memClient() });
    expect(await k.ingest("empty", "   ")).toBe(0);
    expect(await k.ingest("real", "Some real content here that forms one chunk.")).toBe(1);
  });
});

describe("createKnowledge — optional embedding index", () => {
  function fakeEmbed(vectors: Record<string, number[]>) {
    return async (texts: string[]): Promise<number[][]> => texts.map((t) => vectors[t] ?? [0, 0, 0]);
  }

  test("when `embed` is supplied, recall ranks by cosine similarity over stored embeddings", async () => {
    const vectors: Record<string, number[]> = {
      "about cats": [1, 0, 0],
      "about dogs": [0, 1, 0],
      "feline query": [0.9, 0.1, 0],
    };
    const k = createKnowledge({ client: memClient(), embed: fakeEmbed(vectors) });
    await k.ingest("cats", "about cats");
    await k.ingest("dogs", "about dogs");
    const results = await k.recall("feline query");
    expect(results[0]!.sourceId).toBe("cats");
  });

  test("an empty store with embeddings configured still returns no results", async () => {
    const k = createKnowledge({ client: memClient(), embed: fakeEmbed({}) });
    const results = await k.recall("anything");
    expect(results).toEqual([]);
  });
});

describe("createKnowledgeRag — the real AgentDeps.retrieveRag hook (§9 Scenario B)", () => {
  test("recalls chunk text for a matching query", async () => {
    const knowledge = createKnowledge({ client: memClient() });
    await knowledge.ingest("hours", "Our store hours are 9am to 5pm, Monday through Friday.");
    const retrieveRag = createKnowledgeRag({ knowledge });
    const snippets = await retrieveRag({ contactId: "c1", query: "what are your store hours" });
    expect(snippets.length).toBe(1);
    expect(snippets[0]).toContain("9am to 5pm");
  });

  test("an empty store returns no snippets — the compose step, not this hook, is responsible for an honest 'I don't know'", async () => {
    const knowledge = createKnowledge({ client: memClient() });
    const retrieveRag = createKnowledgeRag({ knowledge });
    const snippets = await retrieveRag({ contactId: "c1", query: "anything" });
    expect(snippets).toEqual([]);
  });

  test("an empty query short-circuits without touching the store", async () => {
    let recallCalled = false;
    const knowledge = createKnowledge({ client: memClient() });
    const originalRecall = knowledge.recall.bind(knowledge);
    knowledge.recall = async (...args) => {
      recallCalled = true;
      return originalRecall(...args);
    };
    const retrieveRag = createKnowledgeRag({ knowledge });
    const snippets = await retrieveRag({ contactId: "c1", query: "" });
    expect(snippets).toEqual([]);
    expect(recallCalled).toBe(false);
  });

  test("topK/scoreFloor options are threaded through to recall()", async () => {
    const knowledge = createKnowledge({ client: memClient() });
    for (let i = 0; i < 5; i++) await knowledge.ingest(`doc${i}`, `Shipping and returns policy notes, case ${i}.`);
    const retrieveRag = createKnowledgeRag({ knowledge, topK: 2 });
    const snippets = await retrieveRag({ contactId: "c1", query: "shipping returns" });
    expect(snippets.length).toBe(2);
  });

  test("when `memory` is supplied, past-conversation snippets (T6.4 recallWithBudget) are appended after Knowledge chunks", async () => {
    const knowledge = createKnowledge({ client: memClient() });
    await knowledge.ingest("hours", "Our store hours are 9am to 5pm, Monday through Friday.");
    const memory: Memory = {
      load: async () => [],
      append: async () => undefined,
      recall: async (contactId, query) => (contactId === "c1" && query.includes("hours") ? ["earlier the user said they usually visit on weekend hours"] : []),
    };
    const retrieveRag = createKnowledgeRag({ knowledge, memory });
    const snippets = await retrieveRag({ contactId: "c1", query: "what are your store hours" });
    expect(snippets[0]).toContain("9am to 5pm");
    expect(snippets[1]).toContain("weekend hours");
  });

  test("without `memory`, no Memory.recall call happens at all (Knowledge-only RAG stays the default)", async () => {
    const knowledge = createKnowledge({ client: memClient() });
    await knowledge.ingest("hours", "Our store hours are 9am to 5pm.");
    const retrieveRag = createKnowledgeRag({ knowledge });
    const snippets = await retrieveRag({ contactId: "c1", query: "store hours" });
    expect(snippets).toEqual(["Our store hours are 9am to 5pm."]);
  });
});

describe("createKnowledge — latency bound at scale", () => {
  test("recall over a 10,000-chunk store completes within a generous bound", async () => {
    const k = createKnowledge({ client: memClient() });
    const topics = ["shipping", "returns", "hours", "warranty", "payments"];
    const text = Array.from({ length: 10_000 }, (_, i) => `Paragraph ${i} discusses ${topics[i % topics.length]} policy in detail for case ${i}.`).join("\n\n");
    await k.ingest("bulk", text, { maxChunkChars: 120 });

    const start = Date.now();
    const results = await k.recall("shipping policy", { topK: 5 });
    const elapsedMs = Date.now() - start;

    expect(results.length).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(5000);
  }, 15_000);
});
