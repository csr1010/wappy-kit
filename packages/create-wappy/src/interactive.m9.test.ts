import { describe, expect, test, vi } from "vitest";

/**
 * `interactive.ts` is a thin `@clack/prompts` layer (per its own file header) — the logic worth
 * testing is the SEQUENCING (does it ask the right question next, in order) and the ANSWER MAPPING
 * (does a clack pick turn into the right typed `Answer` shape), not clack's own rendering. Fully
 * testable by mocking `@clack/prompts` with a scripted response queue (including a CANCEL sentinel),
 * no real TTY required.
 *
 * The interview's "tools" step (M9, Shopify) was removed entirely (domain connectors are out of
 * scope for this open-source repo now) — this file was rewritten accordingly (`--allow-test-change`,
 * SPEC.md decisions log). A "productivity" step was added back later — updated again to script both
 * `select()` calls, same reasoning. There's still no natural "the state machine rejects this answer,
 * re-prompt" scenario to exercise here (clack's own `select()` can only ever return one of the
 * choices it was given) — that invalid-combo coverage lives in `interview.m9.test.ts`'s own
 * `applyAnswer` tests instead.
 *
 * --allow-test-change (M15, "Memory backend — local vs. Cognee"): a "memory" step was inserted
 * between model and productivity — updated to script all three `select()` calls, and to assert the
 * real `hint` passthrough (the one thing genuinely new in `selectOne` for this step, since no prior
 * step's choices used `hint`).
 */

const CANCEL = Symbol("cancel");
type Scripted<T> = (T | typeof CANCEL)[];

const state: { select: Scripted<string>; selectCalls: { message: string; options: { value: string; label: string; hint?: string }[] }[] } = { select: [], selectCalls: [] };

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
  select: vi.fn(async (args: { message: string; options: { value: string; label: string; hint?: string }[] }) => {
    state.selectCalls.push(args);
    return shift(state.select);
  }),
}));

async function importFresh() {
  vi.resetModules();
  return import("./interactive.js");
}

function reset() {
  state.select = [];
  state.selectCalls = [];
}

describe("runInteractiveInterview — sequencing + answer mapping (clack mocked)", () => {
  test("asks model, memory, then productivity, then finishes — no credential question", async () => {
    reset();
    state.select = ["anthropic", "cognee", "yes"];

    const { runInteractiveInterview } = await importFresh();
    const answers = await runInteractiveInterview();

    expect(answers).toEqual({ model: { provider: "anthropic" }, memory: { backend: "cognee" }, productivity: { enabled: true } });
    expect(state.select).toHaveLength(0);
  });

  test("the memory step's select() options carry the real hint text through, not dropped", async () => {
    reset();
    state.select = ["openai", "local", "no"];

    const { runInteractiveInterview } = await importFresh();
    await runInteractiveInterview();

    const memoryCall = state.selectCalls[1]!;
    const cogneeOption = memoryCall.options.find((o) => o.value === "cognee");
    expect(cogneeOption?.hint).toBeTruthy();
  });
});

describe("runInteractiveInterview — cancellation (clack's isCancel) exits rather than continuing with garbage", () => {
  test("cancelling the model select() exits", async () => {
    reset();
    state.select = [CANCEL];
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((() => {
      throw new Error("process.exit called");
    }) as unknown) as (code?: number) => never);

    const { runInteractiveInterview } = await importFresh();
    await expect(runInteractiveInterview()).rejects.toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});
