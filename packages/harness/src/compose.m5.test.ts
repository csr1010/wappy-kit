import { describe, expect, test } from "vitest";
import type { Model, ModelRequest, ModelResult } from "@wappy/core";
import { composeSmartMessage } from "./compose.js";

function scriptedModel(fn: (req: ModelRequest, callIndex: number) => ModelResult): Model {
  let calls = 0;
  return { generate: async (req) => fn(req, calls++) };
}

describe("composeSmartMessage — happy path", () => {
  test("a valid SmartMessage on the first attempt is returned as-is, one model call", async () => {
    let calls = 0;
    const model = scriptedModel(() => {
      calls++;
      return { structured: { text: "Hi there!" } };
    });
    const result = await composeSmartMessage({ model, prompt: "greet the user" });
    expect(result).toEqual({ text: "Hi there!" });
    expect(calls).toBe(1);
  });

  test("a valid rich SmartMessage (buttons) round-trips fully", async () => {
    const smart = { text: "Pick one:", buttons: [{ id: "a", title: "Option A" }] };
    const model = scriptedModel(() => ({ structured: smart }));
    expect(await composeSmartMessage({ model, prompt: "offer options" })).toEqual(smart);
  });
});

describe("composeSmartMessage — repair", () => {
  test("invalid structured output on attempt 1, valid on attempt 2 (repair) — returned, and the repair prompt says so", async () => {
    const seenPrompts: string[] = [];
    const model = scriptedModel((req, i) => {
      seenPrompts.push(req.prompt);
      if (i === 0) return { structured: { notAValidField: true } };
      return { structured: { text: "Fixed reply" } };
    });
    const result = await composeSmartMessage({ model, prompt: "greet the user" });
    expect(result).toEqual({ text: "Fixed reply" });
    expect(seenPrompts).toHaveLength(2);
    expect(seenPrompts[1]).toContain("greet the user");
    expect(seenPrompts[1]).not.toBe(seenPrompts[0]); // repair attempt's prompt differs from the original
  });

  test("a model throw on attempt 1 followed by a valid attempt 2 recovers (errors treated like malformed output)", async () => {
    const model = scriptedModel((_req, i) => {
      if (i === 0) throw new Error("model API is down");
      return { structured: { text: "recovered" } };
    });
    expect(await composeSmartMessage({ model, prompt: "hi" })).toEqual({ text: "recovered" });
  });
});

describe("composeSmartMessage — degrade to plain text", () => {
  test("invalid on both attempts, but attempt 1 had free text -> degrades to that text", async () => {
    const model = scriptedModel((_req, i) => {
      if (i === 0) return { text: "here's a plain reply", structured: { garbage: true } };
      return { structured: { stillGarbage: true } };
    });
    expect(await composeSmartMessage({ model, prompt: "hi" })).toEqual({ text: "here's a plain reply" });
  });

  test("invalid on both attempts, both had free text -> the LATEST (repaired) attempt's text wins", async () => {
    const model = scriptedModel((_req, i) => {
      if (i === 0) return { text: "first attempt text", structured: { garbage: true } };
      return { text: "second attempt text", structured: { stillGarbage: true } };
    });
    expect(await composeSmartMessage({ model, prompt: "hi" })).toEqual({ text: "second attempt text" });
  });

  test("invalid on both attempts, NEITHER had any text at all -> an honest generic fallback, never empty/silent", async () => {
    const model = scriptedModel(() => ({ structured: { garbage: true } }));
    const result = await composeSmartMessage({ model, prompt: "hi" });
    expect(result.text).toBeTruthy();
    expect(result.text!.length).toBeGreaterThan(0);
  });

  test("the model throwing on both attempts also degrades to the honest fallback, never propagates", async () => {
    const model: Model = { generate: async () => { throw new Error("down"); } };
    const result = await composeSmartMessage({ model, prompt: "hi" });
    expect(result.text).toBeTruthy();
  });

  test("no structured field and no text at all on either attempt still returns a non-empty fallback", async () => {
    const model = scriptedModel(() => ({}));
    const result = await composeSmartMessage({ model, prompt: "hi" });
    expect(result.text).toBeTruthy();
  });
});
