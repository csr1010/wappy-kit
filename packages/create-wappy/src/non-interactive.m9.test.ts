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

// The interview's "tools" step (M9, Shopify, --api flag) was removed entirely — domain connectors
// are out of scope for this open-source repo now. Rewritten accordingly (`--allow-test-change`,
// SPEC.md decisions log).
describe("resolveNonInteractiveAnswers — same answers as the interactive interview", () => {
  test("--model openai resolves a complete answer set", () => {
    expect(ok({ model: "openai" })).toEqual({ model: { provider: "openai" } });
  });
});

describe("--yes fills omitted steps with the defaults", () => {
  test("--yes alone resolves to the defaults", () => {
    expect(ok({ yes: true })).toEqual({ model: DEFAULT_ANSWERS.model });
  });

  test("explicit flags win over --yes defaults", () => {
    expect(ok({ yes: true, model: "gemini" }).model).toEqual({ provider: "gemini" });
  });
});

describe("errors", () => {
  test("without --yes, the omitted step is reported", () => {
    expect(errors({})).toEqual(['Missing required flag for step "model" (pass it explicitly, or use --yes to accept the default).']);
  });

  test("an unrecognized --model value is a parse error", () => {
    expect(errors({ model: "cohere" })).toEqual(['--model must be one of openai|anthropic|gemini|ollama, got "cohere".']);
  });
});
