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
//
// A "productivity" step was added back later (--productivity yes|no, @wappy_ai/productivity).
//
// --allow-test-change (M15, "Memory backend — local vs. Cognee"): a "memory" step (--memory
// local|cognee) was inserted between model and productivity — every "resolves a complete answer
// set"/error-count assertion below needed all three flags supplied (or --yes) to stay accurate now
// that there are three steps, not two.
describe("resolveNonInteractiveAnswers — same answers as the interactive interview", () => {
  test("--model openai --memory local --productivity no resolves a complete answer set", () => {
    expect(ok({ model: "openai", memory: "local", productivity: "no" })).toEqual({
      model: { provider: "openai" },
      memory: { backend: "local" },
      productivity: { enabled: false },
    });
  });

  test("--memory cognee is a real, honored answer", () => {
    expect(ok({ model: "openai", memory: "cognee", productivity: "no" }).memory).toEqual({ backend: "cognee" });
  });

  test("--productivity yes is a real, honored answer", () => {
    expect(ok({ model: "openai", memory: "local", productivity: "yes" }).productivity).toEqual({ enabled: true });
  });
});

describe("--yes fills omitted steps with the defaults", () => {
  test("--yes alone resolves to the defaults", () => {
    expect(ok({ yes: true })).toEqual({ model: DEFAULT_ANSWERS.model, memory: DEFAULT_ANSWERS.memory, productivity: DEFAULT_ANSWERS.productivity });
  });

  test("explicit flags win over --yes defaults", () => {
    expect(ok({ yes: true, model: "gemini" }).model).toEqual({ provider: "gemini" });
    expect(ok({ yes: true, memory: "cognee" }).memory).toEqual({ backend: "cognee" });
    expect(ok({ yes: true, productivity: "yes" }).productivity).toEqual({ enabled: true });
  });
});

describe("errors", () => {
  test("without --yes, every omitted step is reported", () => {
    expect(errors({})).toEqual([
      'Missing required flag for step "model" (pass it explicitly, or use --yes to accept the default).',
      'Missing required flag for step "memory" (pass it explicitly, or use --yes to accept the default).',
      'Missing required flag for step "productivity" (pass it explicitly, or use --yes to accept the default).',
    ]);
  });

  test("an unrecognized --model value is a parse error", () => {
    expect(errors({ model: "cohere", memory: "local", productivity: "no" })).toEqual(['--model must be one of openai|anthropic|gemini|ollama, got "cohere".']);
  });

  test("an unrecognized --memory value is a parse error", () => {
    expect(errors({ model: "openai", memory: "redis", productivity: "no" })).toEqual(['--memory must be "local" or "cognee", got "redis".']);
  });

  test("an unrecognized --productivity value is a parse error", () => {
    expect(errors({ model: "openai", memory: "local", productivity: "sure" })).toEqual(['--productivity must be "yes" or "no", got "sure".']);
  });
});
