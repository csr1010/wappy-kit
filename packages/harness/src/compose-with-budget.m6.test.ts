import { describe, expect, test } from "vitest";
import type { Model, ModelRequest, ModelResult } from "@wappy/core";
import { composeWithBudget } from "./compose-with-budget.js";
import { createContextBudget } from "./context-budget.js";

const budget = createContextBudget("gpt-4o-mini", { overrides: { contextWindow: 10_000, reservedOutputTokens: 0 } });

function scriptedModel(fn: (req: ModelRequest, callIndex: number) => ModelResult): Model {
  let calls = 0;
  return { generate: async (req) => fn(req, calls++) };
}

function contextLengthError(): Error {
  return Object.assign(new Error("context length exceeded"), { code: "context_length_exceeded" });
}

describe("composeWithBudget — happy path", () => {
  test("a valid SmartMessage on the first attempt is returned, one model call", async () => {
    let calls = 0;
    const model = scriptedModel(() => {
      calls++;
      return { structured: { text: "hi!" } };
    });
    const result = await composeWithBudget({ model, input: { system: "SYS", userMessage: "hello" }, budget });
    expect(result.reply).toEqual({ text: "hi!" });
    expect(result.shrunkForContextLength).toBe(false);
    expect(calls).toBe(1);
  });

  test("usage/dropped from the assembler are surfaced on the result", async () => {
    const model = scriptedModel(() => ({ structured: { text: "hi!" } }));
    const result = await composeWithBudget({ model, input: { system: "SYS", userMessage: "hello" }, budget });
    expect(result.usage.system).toBeGreaterThan(0);
    expect(result.dropped).toEqual([]);
  });
});

describe("composeWithBudget — context-length error: shrink and retry once", () => {
  test("a context-length error on attempt 1 shrinks the budget by 25% for attempt 2, without adding a repair note", async () => {
    const seenPrompts: string[] = [];
    const model = scriptedModel((req, i) => {
      seenPrompts.push(req.prompt);
      if (i === 0) throw contextLengthError();
      return { structured: { text: "fits now" } };
    });
    const result = await composeWithBudget({ model, input: { system: "SYS", userMessage: "hello" }, budget });
    expect(result.reply).toEqual({ text: "fits now" });
    expect(result.shrunkForContextLength).toBe(true);
    expect(seenPrompts).toHaveLength(2);
    expect(seenPrompts[1]).not.toContain("schema"); // no repair note added for a context-length failure
  });

  test("a context-length error persisting on the retry degrades to an honest message, not a crash", async () => {
    const model = scriptedModel(() => { throw contextLengthError(); });
    const result = await composeWithBudget({ model, input: { system: "SYS", userMessage: "hello" }, budget });
    expect(result.reply.text).toBeTruthy();
    expect(result.shrunkForContextLength).toBe(true);
  });

  test("the smaller budget on retry actually produces a smaller assembled prompt", async () => {
    const bigBudget = createContextBudget("x", { overrides: { contextWindow: 5000, reservedOutputTokens: 0 } });
    const seenPrompts: string[] = [];
    const model = scriptedModel((req, i) => {
      seenPrompts.push(req.prompt);
      if (i === 0) throw contextLengthError();
      return { structured: { text: "ok" } };
    });
    const recalledSnippets = Array.from({ length: 50 }, (_, i) => `snippet ${i} with some real content in it`);
    await composeWithBudget({ model, input: { system: "SYS", recalledSnippets, userMessage: "hello" }, budget: bigBudget });
    expect(seenPrompts[1]!.length).toBeLessThanOrEqual(seenPrompts[0]!.length);
  });
});

describe("composeWithBudget — malformed (non-context-length) output still gets a repair attempt", () => {
  test("invalid structured output on attempt 1, valid on attempt 2 (repair note, not budget shrink)", async () => {
    const seenPrompts: string[] = [];
    const model = scriptedModel((req, i) => {
      seenPrompts.push(req.prompt);
      if (i === 0) return { structured: { garbage: true } };
      return { structured: { text: "fixed" } };
    });
    const result = await composeWithBudget({ model, input: { system: "SYS", userMessage: "hello" }, budget });
    expect(result.reply).toEqual({ text: "fixed" });
    expect(result.shrunkForContextLength).toBe(false);
    expect(seenPrompts[1]).toContain("schema"); // the repair note WAS added for a non-context-length failure
  });

  test("a non-Error, non-string thrown value is still stringified without crashing the detection logic", async () => {
    const model = scriptedModel((_req, i) => {
      if (i === 0) throw "just a plain string throw";
      return { structured: { text: "recovered" } };
    });
    const result = await composeWithBudget({ model, input: { system: "SYS", userMessage: "hello" }, budget });
    expect(result.reply).toEqual({ text: "recovered" });
    expect(result.shrunkForContextLength).toBe(false);
  });

  test("a non-context-length error is also treated as malformed and retried with a repair note", async () => {
    const model = scriptedModel((_req, i) => {
      if (i === 0) throw new Error("some transient network blip");
      return { structured: { text: "recovered" } };
    });
    const result = await composeWithBudget({ model, input: { system: "SYS", userMessage: "hello" }, budget });
    expect(result.reply).toEqual({ text: "recovered" });
    expect(result.shrunkForContextLength).toBe(false);
  });

  test("invalid on both attempts degrades to whichever text either attempt produced", async () => {
    const model = scriptedModel((_req, i) => {
      if (i === 0) return { text: "first attempt text", structured: { garbage: true } };
      return { structured: { stillGarbage: true } };
    });
    const result = await composeWithBudget({ model, input: { system: "SYS", userMessage: "hello" }, budget });
    expect(result.reply).toEqual({ text: "first attempt text" });
  });

  test("invalid on both attempts with no text anywhere falls back to an honest generic message", async () => {
    const model = scriptedModel(() => ({ structured: { garbage: true } }));
    const result = await composeWithBudget({ model, input: { system: "SYS", userMessage: "hello" }, budget });
    expect(result.reply.text).toBeTruthy();
  });
});
