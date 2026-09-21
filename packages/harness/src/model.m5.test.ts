import { describe, expect, test } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { APICallError } from "ai";
import { createVercelModel } from "./model.js";
import type { Tool } from "@wappy/core";

describe("createVercelModel — text", () => {
  test("a plain prompt with no tools/schema returns generated text", async () => {
    const mock = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: "hi there!" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: { total: 1, text: 1, cache: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } },
        warnings: [],
      }),
    });
    const model = createVercelModel({ model: mock });
    const result = await model.generate({ prompt: "hello" });
    expect(result).toEqual({ text: "hi there!" });
  });

  test("history is forwarded as prior turns, most-recent prompt appended last", async () => {
    let seenMessages: unknown;
    const mock = new MockLanguageModelV4({
      doGenerate: async (opts) => {
        seenMessages = opts.prompt;
        return { content: [{ type: "text", text: "ok" }], finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: {}, outputTokens: {} }, warnings: [] };
      },
    });
    const model = createVercelModel({ model: mock });
    await model.generate({
      prompt: "and now?",
      history: [
        { id: "t1", contactId: "c1", role: "user", text: "hi", timestamp: 0 },
        { id: "t2", contactId: "c1", role: "agent", text: "hello!", timestamp: 1 },
      ],
    });
    expect(seenMessages).toMatchObject([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello!" }] },
      { role: "user", content: [{ type: "text", text: "and now?" }] },
    ]);
  });

  test("a system turn maps to a system message, not user/assistant", async () => {
    let seenMessages: unknown;
    const mock = new MockLanguageModelV4({
      doGenerate: async (opts) => {
        seenMessages = opts.prompt;
        return { content: [{ type: "text", text: "ok" }], finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: {}, outputTokens: {} }, warnings: [] };
      },
    });
    const model = createVercelModel({ model: mock });
    await model.generate({
      prompt: "hi",
      history: [{ id: "t1", contactId: "c1", role: "system", text: "the store closes at 9pm", timestamp: 0 }],
    });
    expect(seenMessages).toMatchObject([
      { role: "system", content: "the store closes at 9pm" },
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
  });

  test("a history turn with no text is skipped (e.g. a system marker with only `meta`)", async () => {
    let seenMessages: unknown;
    const mock = new MockLanguageModelV4({
      doGenerate: async (opts) => {
        seenMessages = opts.prompt;
        return { content: [{ type: "text", text: "ok" }], finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: {}, outputTokens: {} }, warnings: [] };
      },
    });
    const model = createVercelModel({ model: mock });
    await model.generate({
      prompt: "hi",
      history: [{ id: "t1", contactId: "c1", role: "system", timestamp: 0, meta: { kind: "join" } }],
    });
    expect(seenMessages).toHaveLength(1); // only the new prompt — the textless history turn contributed nothing
  });
});

describe("createVercelModel — structured output", () => {
  test("responseSchema drives generateObject and returns the parsed object under `structured`", async () => {
    const mock = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: JSON.stringify({ intent: "greeting", needsRAG: false, needsTool: false, escalate: false, confidence: 0.9 }) }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: {}, outputTokens: {} },
        warnings: [],
      }),
    });
    const model = createVercelModel({ model: mock });
    const result = await model.generate({
      prompt: "hi",
      responseSchema: {
        type: "object",
        properties: { intent: { type: "string" }, needsRAG: { type: "boolean" }, needsTool: { type: "boolean" }, escalate: { type: "boolean" }, confidence: { type: "number" } },
        required: ["intent", "needsRAG", "needsTool", "escalate", "confidence"],
      },
    });
    expect(result).toEqual({ structured: { intent: "greeting", needsRAG: false, needsTool: false, escalate: false, confidence: 0.9 } });
  });
});

describe("createVercelModel — tool loop", () => {
  function fakeTool(name: string, run: (args: unknown) => Promise<unknown>): Tool {
    return {
      name,
      description: `does ${name}`,
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      readOnly: true,
      confirmBefore: false,
      execute: async (args) => {
        try {
          return { toolName: name, ok: true, data: await run(args) };
        } catch (e) {
          return { toolName: name, ok: false, error: String(e) };
        }
      },
    };
  }

  test("a tool call is executed for real (via Tool.execute) and the model's follow-up text composes the final reply", async () => {
    let executed: unknown;
    const getOrder = fakeTool("getOrder", async (args) => {
      executed = args;
      return { status: "shipped" };
    });

    const mock = new MockLanguageModelV4({
      doGenerate: [
        {
          content: [{ type: "tool-call", toolCallId: "call1", toolName: "getOrder", input: JSON.stringify({ id: "8842" }) }],
          finishReason: { unified: "tool-calls", raw: "tool_calls" },
          usage: { inputTokens: {}, outputTokens: {} },
          warnings: [],
        },
        {
          content: [{ type: "text", text: "Your order 8842 has shipped!" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: { inputTokens: {}, outputTokens: {} },
          warnings: [],
        },
      ],
    });
    const model = createVercelModel({ model: mock, maxToolSteps: 3 });
    const result = await model.generate({ prompt: "where's my order 8842?", tools: [getOrder] });

    expect(executed).toEqual({ id: "8842" });
    expect(result.text).toBe("Your order 8842 has shipped!");
    expect(result.toolCalls).toEqual([{ name: "getOrder", args: { id: "8842" } }]);
  });

  test("without maxToolSteps room to compose, a bare tool call is still reported (no crash, just no follow-up text)", async () => {
    const getOrder = fakeTool("getOrder", async () => ({ status: "shipped" }));
    const mock = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "tool-call", toolCallId: "call1", toolName: "getOrder", input: JSON.stringify({ id: "8842" }) }],
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
        usage: { inputTokens: {}, outputTokens: {} },
        warnings: [],
      }),
    });
    const model = createVercelModel({ model: mock, maxToolSteps: 1 });
    const result = await model.generate({ prompt: "where's my order 8842?", tools: [getOrder] });
    expect(result.toolCalls).toEqual([{ name: "getOrder", args: { id: "8842" } }]);
    expect(result.text).toBeUndefined();
  });

  test("no tool calls made -> toolCalls is omitted, not an empty array", async () => {
    const getOrder = fakeTool("getOrder", async () => ({}));
    const mock = new MockLanguageModelV4({
      doGenerate: async () => ({ content: [{ type: "text", text: "hi!" }], finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: {}, outputTokens: {} }, warnings: [] }),
    });
    const model = createVercelModel({ model: mock });
    const result = await model.generate({ prompt: "hi", tools: [getOrder] });
    expect(result).toEqual({ text: "hi!" });
  });
});

describe("createVercelModel — 429/5xx backoff retry", () => {
  test("a retryable transient failure is retried (delegated to the AI SDK's own maxRetries), not surfaced as an error", async () => {
    let attempts = 0;
    const mock = new MockLanguageModelV4({
      doGenerate: async () => {
        attempts++;
        if (attempts === 1) {
          throw new APICallError({ message: "rate limited", url: "https://example.test", requestBodyValues: {}, statusCode: 429, isRetryable: true });
        }
        return { content: [{ type: "text", text: "ok after retry" }], finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: {}, outputTokens: {} }, warnings: [] };
      },
    });
    const model = createVercelModel({ model: mock, maxRetries: 2 });
    const result = await model.generate({ prompt: "hi" });
    expect(result).toEqual({ text: "ok after retry" });
    expect(attempts).toBe(2);
  });

  test("a non-retryable failure is not retried and propagates", async () => {
    let attempts = 0;
    const mock = new MockLanguageModelV4({
      doGenerate: async () => {
        attempts++;
        throw new APICallError({ message: "bad request", url: "https://example.test", requestBodyValues: {}, statusCode: 400, isRetryable: false });
      },
    });
    const model = createVercelModel({ model: mock, maxRetries: 2 });
    await expect(model.generate({ prompt: "hi" })).rejects.toThrow();
    expect(attempts).toBe(1);
  });
});

describe("createVercelModel — timeout/abort", () => {
  test("timeoutMs aborts a call that never resolves", async () => {
    const mock = new MockLanguageModelV4({
      doGenerate: (opts) =>
        new Promise((_resolve, reject) => {
          opts.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    const model = createVercelModel({ model: mock, timeoutMs: 10 });
    await expect(model.generate({ prompt: "hi" })).rejects.toThrow();
  });
});
