import { describe, expect, test } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { createVercelModel } from "./model.js";

describe("createVercelModel — system message (T6.2 review fix #1)", () => {
  test("req.system is sent as a leading system-role message, ahead of history and the prompt", async () => {
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
      system: "You are a helpful assistant.",
      history: [{ id: "t1", contactId: "c1", role: "user", text: "hi", timestamp: 0 }],
    });
    expect(seenMessages).toMatchObject([
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "user", content: [{ type: "text", text: "and now?" }] },
    ]);
  });

  test("no req.system means no system-role message is added", async () => {
    let seenMessages: unknown;
    const mock = new MockLanguageModelV4({
      doGenerate: async (opts) => {
        seenMessages = opts.prompt;
        return { content: [{ type: "text", text: "ok" }], finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: {}, outputTokens: {} }, warnings: [] };
      },
    });
    const model = createVercelModel({ model: mock });
    await model.generate({ prompt: "hello" });
    expect(seenMessages).toMatchObject([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
    expect((seenMessages as unknown[]).length).toBe(1);
  });
});
