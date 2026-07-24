import { describe, expect, test, vi } from "vitest";

/**
 * `interactive.ts` is a thin `@clack/prompts` layer (per its own file header) — the logic worth
 * testing is the SEQUENCING (does it ask the right question next, in order, re-prompting on an
 * invalid answer) and the ANSWER MAPPING (does a clack pick turn into the right typed `Answer`
 * shape), not clack's own rendering. Both are fully testable by mocking `@clack/prompts` with a
 * scripted response queue (including a CANCEL sentinel at any position), no
 * real TTY required.
 */

const CANCEL = Symbol("cancel");
type Scripted<T> = (T | typeof CANCEL)[];

const state: { select: Scripted<string>; multiselect: Scripted<string[]> } = { select: [], multiselect: [] };

function shift<T>(queue: Scripted<T>): T | typeof CANCEL {
  if (queue.length === 0) throw new Error("test setup: prompt queue exhausted");
  return queue.shift()!;
}

vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  isCancel: (v: unknown) => v === CANCEL,
  log: { error: vi.fn() },
  select: vi.fn(async () => shift(state.select)),
  multiselect: vi.fn(async () => shift(state.multiselect)),
}));

async function importFresh() {
  vi.resetModules();
  return import("./interactive.js");
}

function reset() {
  state.select = [];
  state.multiselect = [];
}

describe("runInteractiveInterview — sequencing + answer mapping (clack mocked)", () => {
  test("no store: asks only model and tools, then finishes — skills are never asked, no credential is asked", async () => {
    reset();
    state.select = ["anthropic", "none"];

    const { runInteractiveInterview } = await importFresh();
    const answers = await runInteractiveInterview();

    expect(answers).toEqual({ model: { provider: "anthropic" }, tools: { kind: "none" } });
    expect(state.select).toHaveLength(0);
    expect(state.multiselect).toHaveLength(0);
  });

  test("Shopify: skills multiselect follows the tools step; no store domain or token is asked", async () => {
    reset();
    state.select = ["openai", "shopify"];
    state.multiselect = [["store-info", "orders"]];

    const { runInteractiveInterview } = await importFresh();
    const answers = await runInteractiveInterview();

    expect(answers).toEqual({ model: { provider: "openai" }, tools: { kind: "shopify" }, skills: { skills: ["store-info", "orders"] } });
    expect(state.select).toHaveLength(0);
    expect(state.multiselect).toHaveLength(0);
  });

  test("picking no skills (empty multiselect) is valid", async () => {
    reset();
    state.select = ["gemini", "shopify"];
    state.multiselect = [[]];
    const { runInteractiveInterview } = await importFresh();
    expect((await runInteractiveInterview()).skills).toEqual({ skills: [] });
  });

  test("an answer the state machine rejects is reported and the same step is asked again", async () => {
    reset();
    // First tools pick is bogus (applyAnswer rejects it); nextQuestion() is still "tools", so the
    // step re-runs instead of the interview continuing with a bad value.
    state.select = ["openai", "openapi", "none"];
    const { log } = await import("@clack/prompts");

    const { runInteractiveInterview } = await importFresh();
    const answers = await runInteractiveInterview();
    expect(answers.tools).toEqual({ kind: "none" });
    expect(log.error).toHaveBeenCalledWith('tools: unknown kind "openapi".');
    expect(state.select).toHaveLength(0);
  });
});

describe("runInteractiveInterview — cancellation (clack's isCancel) exits rather than continuing with garbage", () => {
  function mockExit() {
    return vi.spyOn(process, "exit").mockImplementation(((() => {
      throw new Error("process.exit called");
    }) as unknown) as (code?: number) => never);
  }

  async function expectCancelExit() {
    const exitSpy = mockExit();
    const { runInteractiveInterview } = await importFresh();
    await expect(runInteractiveInterview()).rejects.toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  }

  test("cancelling the very first select() (the model step)", async () => {
    reset();
    state.select = [CANCEL];
    await expectCancelExit();
  });

  test("cancelling the tools select()", async () => {
    reset();
    state.select = ["openai", CANCEL];
    await expectCancelExit();
  });

  test("cancelling the skills multiselect()", async () => {
    reset();
    state.select = ["openai", "shopify"];
    state.multiselect = [CANCEL];
    await expectCancelExit();
  });
});
