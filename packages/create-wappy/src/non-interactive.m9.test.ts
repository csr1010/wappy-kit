import { describe, expect, test } from "vitest";
import { DEFAULT_ANSWERS } from "./interview.js";
import { resolveNonInteractiveAnswers } from "./non-interactive.js";

function ok(flags: Parameters<typeof resolveNonInteractiveAnswers>[0]) {
  const r = resolveNonInteractiveAnswers(flags);
  if (!r.ok) throw new Error(`expected ok, got errors: ${r.errors.join(" | ")}`);
  return r.answers;
}
function errors(flags: Parameters<typeof resolveNonInteractiveAnswers>[0]) {
  const r = resolveNonInteractiveAnswers(flags);
  if (r.ok) throw new Error("expected errors, got ok");
  return r.errors;
}

describe("resolveNonInteractiveAnswers — same answers as the interactive interview", () => {
  test("--model openai --api none resolves a complete answer set with no skills step", () => {
    expect(ok({ model: "openai", api: "none" })).toEqual({ model: { provider: "openai" }, tools: { kind: "none" } });
  });

  test("--api shopify needs skills: --skills picks them", () => {
    expect(ok({ model: "anthropic", api: "shopify", skills: "store-info,orders" })).toEqual({
      model: { provider: "anthropic" },
      tools: { kind: "shopify" },
      skills: { skills: ["store-info", "orders"] },
    });
  });

  test('--skills none (or empty) means no skills', () => {
    expect(ok({ model: "gemini", api: "shopify", skills: "none" }).skills).toEqual({ skills: [] });
    expect(ok({ model: "ollama", api: "shopify", skills: "  " }).skills).toEqual({ skills: [] });
  });
});

describe("--yes fills omitted steps with the defaults", () => {
  test("--yes alone resolves to the defaults (no store, so no skills)", () => {
    expect(ok({ yes: true })).toEqual({ model: DEFAULT_ANSWERS.model, tools: DEFAULT_ANSWERS.tools });
  });

  test("--yes with --api shopify defaults skills to none", () => {
    expect(ok({ yes: true, api: "shopify" })).toEqual({ model: DEFAULT_ANSWERS.model, tools: { kind: "shopify" }, skills: { skills: [] } });
  });

  test("explicit flags win over --yes defaults", () => {
    expect(ok({ yes: true, model: "gemini" }).model).toEqual({ provider: "gemini" });
  });
});

describe("errors", () => {
  test("without --yes, every omitted applicable step is reported in one pass", () => {
    expect(errors({})).toEqual([
      'Missing required flag for step "model" (pass it explicitly, or use --yes to accept the default).',
      'Missing required flag for step "tools" (pass it explicitly, or use --yes to accept the default).',
    ]);
  });

  test("with a store and no --skills or --yes, skills is reported missing too", () => {
    expect(errors({ model: "openai", api: "shopify" })).toEqual(['Missing required flag for step "skills" (pass it explicitly, or use --yes to accept the default).']);
  });

  test("unrecognized --model / --api values are parse errors", () => {
    // (a step left unanswered by a parse error also cascades an "out of order" error onto the next
    // step, so assert on the parse error itself.)
    expect(errors({ model: "cohere", api: "none" })[0]).toBe('--model must be one of openai|anthropic|gemini|ollama, got "cohere".');
    expect(errors({ model: "openai", api: "https://x/openapi.json" })).toEqual(['--api must be one of none|shopify, got "https://x/openapi.json".']);
  });

  test("an unknown skill lists the valid ones", () => {
    expect(errors({ model: "openai", api: "shopify", skills: "orders,refunds" })).toEqual(['--skills has unknown skill(s): refunds. Valid: store-info, orders, products, or "none".']);
  });

  test("--skills without a store is rejected (skills only apply to the Shopify path)", () => {
    expect(errors({ model: "openai", api: "none", skills: "orders" })).toEqual(["--skills only applies with --api shopify (skills are chosen once a store is connected)."]);
    // ...but "none" is harmless
    expect(ok({ model: "openai", api: "none", skills: "none" }).tools).toEqual({ kind: "none" });
  });

  test("all problems are collected together, not just the first", () => {
    const e = errors({ model: "cohere", api: "nope" });
    expect(e).toContain('--model must be one of openai|anthropic|gemini|ollama, got "cohere".');
    expect(e).toContain('--api must be one of none|shopify, got "nope".');
  });
});
