import { describe, expect, test } from "vitest";
import { resolveNonInteractiveAnswers, type NonInteractiveFlags } from "./non-interactive.js";

const GOLDEN: NonInteractiveFlags = {
  model: "openai",
  framework: "none",
  skills: "store-info,orders",
  api: "shopify",
  shopifyStoreDomain: "luna-and-co.myshopify.com",
  memory: "local",
  router: "llm",
  whatsapp: "later",
};

describe("resolveNonInteractiveAnswers — the milestone brief's own example combo", () => {
  test("--model openai --memory local --router llm --api shopify --whatsapp later resolves a complete, valid answer set", () => {
    const result = resolveNonInteractiveAnswers(GOLDEN);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.answers).toEqual({
      model: { provider: "openai" },
      framework: { framework: "none" },
      skills: { skills: ["store-info", "orders"] },
      tools: { kind: "shopify", storeDomain: "luna-and-co.myshopify.com" },
      memory: { backend: "local" },
      router: { router: "llm" },
      whatsapp: { mode: "later" },
    });
  });
});

describe("resolveNonInteractiveAnswers — --yes fills in every omitted flag with the spec default", () => {
  test("--yes alone (no other flags) resolves to DEFAULT_ANSWERS", () => {
    const result = resolveNonInteractiveAnswers({ yes: true });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.answers.model).toEqual({ provider: "openai" });
    expect(result.answers.tools).toEqual({ kind: "none" });
    expect(result.answers.whatsapp).toEqual({ mode: "later" });
  });

  test("--yes with SOME flags overridden mixes explicit values and defaults", () => {
    const result = resolveNonInteractiveAnswers({ yes: true, model: "anthropic" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.answers.model).toEqual({ provider: "anthropic" });
    expect(result.answers.memory).toEqual({ backend: "local" }); // default, unspecified
  });
});

describe("resolveNonInteractiveAnswers — missing required flags without --yes", () => {
  test("no flags at all reports a missing-flag error for the first step", () => {
    const result = resolveNonInteractiveAnswers({});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errors.some((e) => e.includes('step "model"'))).toBe(true);
  });

  test("collects a missing-flag error for EVERY omitted step in one pass, not just the first", () => {
    const result = resolveNonInteractiveAnswers({ model: "openai" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    for (const step of ["framework", "skills", "tools", "memory", "router", "whatsapp"]) {
      expect(result.errors.some((e) => e.includes(`step "${step}"`))).toBe(true);
    }
  });
});

describe("resolveNonInteractiveAnswers — parse-level errors (bad enum values)", () => {
  test("an unrecognized --model value is rejected with a clear message, not silently defaulted even with --yes", () => {
    const result = resolveNonInteractiveAnswers({ ...GOLDEN, yes: true, model: "gpt-nope" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errors[0]).toMatch(/--model must be one of/);
  });

  test("an unrecognized --framework/--memory/--router/--whatsapp value is rejected", () => {
    expect(resolveNonInteractiveAnswers({ ...GOLDEN, framework: "nope" }).ok).toBe(false);
    expect(resolveNonInteractiveAnswers({ ...GOLDEN, memory: "nope" }).ok).toBe(false);
    expect(resolveNonInteractiveAnswers({ ...GOLDEN, router: "nope" }).ok).toBe(false);
    expect(resolveNonInteractiveAnswers({ ...GOLDEN, whatsapp: "nope" }).ok).toBe(false);
  });

  test("--skills with an unknown reference skill name is rejected, listing the valid options", () => {
    const result = resolveNonInteractiveAnswers({ ...GOLDEN, skills: "store-info,made-up-skill" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errors[0]).toMatch(/unknown reference skill/);
  });

  test('--skills "none" and an empty string both resolve to no skills', () => {
    const r1 = resolveNonInteractiveAnswers({ ...GOLDEN, skills: "none" });
    const r2 = resolveNonInteractiveAnswers({ ...GOLDEN, skills: "" });
    expect(r1.ok && r1.answers.skills).toEqual({ skills: [] });
    expect(r2.ok && r2.answers.skills).toEqual({ skills: [] });
  });
});

describe("resolveNonInteractiveAnswers — tools (--api) variants", () => {
  test('--api none resolves to tools: {kind: "none"}', () => {
    const result = resolveNonInteractiveAnswers({ ...GOLDEN, api: "none", shopifyStoreDomain: undefined });
    expect(result.ok && result.answers.tools).toEqual({ kind: "none" });
  });

  test("--api shopify without --shopify-store-domain is rejected", () => {
    const result = resolveNonInteractiveAnswers({ ...GOLDEN, api: "shopify", shopifyStoreDomain: undefined });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errors[0]).toMatch(/shopify-store-domain/);
  });

  test("any other --api value is treated as an OpenAPI source (URL or file path)", () => {
    const result = resolveNonInteractiveAnswers({ ...GOLDEN, api: "https://api.example.com/openapi.json", shopifyStoreDomain: undefined });
    expect(result.ok && result.answers.tools).toEqual({ kind: "openapi", source: "https://api.example.com/openapi.json" });
  });
});

describe("resolveNonInteractiveAnswers — router=jev and whatsapp=now sub-flags", () => {
  test("--router jev without --jev-key-path is rejected by applyAnswer's own invalid-combo check", () => {
    const result = resolveNonInteractiveAnswers({ ...GOLDEN, router: "jev" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errors.some((e) => e.includes("jevKeyPath"))).toBe(true);
  });

  test("--router jev with --jev-key-path is accepted", () => {
    const result = resolveNonInteractiveAnswers({ ...GOLDEN, router: "jev", jevKeyPath: "/keys/jev.json" });
    expect(result.ok && result.answers.router).toEqual({ router: "jev", jevKeyPath: "/keys/jev.json" });
  });

  test("--whatsapp now without credential sub-flags is rejected by applyAnswer", () => {
    const result = resolveNonInteractiveAnswers({ ...GOLDEN, whatsapp: "now" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("--whatsapp now with all three credential sub-flags is accepted", () => {
    const result = resolveNonInteractiveAnswers({
      ...GOLDEN,
      whatsapp: "now",
      whatsappPhoneNumberId: "106540352242922",
      whatsappAccessToken: "EAAtest",
      whatsappVerifyToken: "my-verify-token",
    });
    expect(result.ok && result.answers.whatsapp).toEqual({ mode: "now", phoneNumberId: "106540352242922", accessToken: "EAAtest", verifyToken: "my-verify-token" });
  });
});
