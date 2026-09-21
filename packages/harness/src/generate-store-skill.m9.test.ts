import { describe, expect, test } from "vitest";
import type { Model, ModelRequest } from "@wappy/core";
import { DEFAULT_MAX_STORE_CONTEXT_CHARS, generateStoreSkill } from "./generate-store-skill.js";

function textModel(response: string | undefined, capture?: { req?: ModelRequest }): Model {
  return {
    async generate(req) {
      if (capture) capture.req = req;
      return { text: response };
    },
  };
}

describe("generateStoreSkill", () => {
  test("drafts a Skill from real store context, using the model's returned text as the promptFragment", async () => {
    const model = textModel("You can help with candle orders, shipping (2-3 days), and our 45-day return window.");
    const skill = await generateStoreSkill({ model, storeContext: "Luna & Co. sells candles. Ships in 2-3 days. 45-day returns.", toolNames: ["getOrder"] });
    expect(skill).toEqual({
      name: "store-info",
      description: "Answers questions about this store using tailored, store-specific guidance generated at setup time.",
      promptFragment: "You can help with candle orders, shipping (2-3 days), and our 45-day return window.",
      tools: ["getOrder"],
    });
  });

  test("sends the store context and tool names in the prompt, with a system instruction constraining the draft", async () => {
    const capture: { req?: ModelRequest } = {};
    const model = textModel("draft text", capture);
    await generateStoreSkill({ model, storeContext: "We sell shoes.", toolNames: ["searchProducts", "getOrder"] });
    expect(capture.req?.system).toMatch(/do not invent/i);
    expect(capture.req?.prompt).toContain("We sell shoes.");
    expect(capture.req?.prompt).toContain("searchProducts, getOrder");
  });

  test("omits `tools` on the returned Skill when no toolNames were given, and says so in the prompt", async () => {
    const capture: { req?: ModelRequest } = {};
    const model = textModel("General store info here.", capture);
    const skill = await generateStoreSkill({ model, storeContext: "We are a small bakery." });
    expect(skill.tools).toBeUndefined();
    expect(capture.req?.prompt).toContain("(none)");
  });

  test("allows overriding name/description while the promptFragment still comes from the model", async () => {
    const model = textModel("Custom draft.");
    const skill = await generateStoreSkill({ model, storeContext: "context", name: "acme-info", description: "Acme-specific skill." });
    expect(skill.name).toBe("acme-info");
    expect(skill.description).toBe("Acme-specific skill.");
    expect(skill.promptFragment).toBe("Custom draft.");
  });

  test("rejects when storeContext is empty or whitespace-only — nothing to ground a draft in", async () => {
    const model = textModel("should never be called");
    await expect(generateStoreSkill({ model, storeContext: "" })).rejects.toThrow(/storeContext is empty/);
    await expect(generateStoreSkill({ model, storeContext: "   \n  " })).rejects.toThrow(/storeContext is empty/);
  });

  test("rejects when the model returns no usable text, rather than producing a blank promptFragment", async () => {
    const model = textModel(undefined);
    await expect(generateStoreSkill({ model, storeContext: "real facts here" })).rejects.toThrow(/returned no text/);
  });

  test("rejects when the model returns only whitespace text", async () => {
    const model = textModel("   \n\t  ");
    await expect(generateStoreSkill({ model, storeContext: "real facts here" })).rejects.toThrow(/returned no text/);
  });

  test("truncates storeContext to the default max before it reaches the prompt", async () => {
    const capture: { req?: ModelRequest } = {};
    const model = textModel("draft", capture);
    const huge = "x".repeat(DEFAULT_MAX_STORE_CONTEXT_CHARS + 500);
    await generateStoreSkill({ model, storeContext: huge });
    const sentContextLine = capture.req!.prompt.split("\n\n")[0]!;
    // "Store facts:\n" prefix + the (possibly truncated) context.
    expect(sentContextLine.length).toBeLessThanOrEqual(DEFAULT_MAX_STORE_CONTEXT_CHARS + "Store facts:\n".length);
  });

  test("a caller-supplied maxStoreContextChars overrides the default", async () => {
    const capture: { req?: ModelRequest } = {};
    const model = textModel("draft", capture);
    await generateStoreSkill({ model, storeContext: "abcdefghij", maxStoreContextChars: 5 });
    expect(capture.req?.prompt).toContain("Store facts:\nabcde");
    expect(capture.req?.prompt).not.toContain("abcdef");
  });
});
