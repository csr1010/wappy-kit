import { describe, expect, test, vi } from "vitest";

/**
 * `interactive.ts` is a thin `@clack/prompts` layer (per its own file header) — the logic worth
 * testing is the SEQUENCING (does it ask the right question next, in order, re-prompting on an
 * invalid answer) and the ANSWER MAPPING (does a clack pick turn into the right typed `Answer`
 * shape), not clack's own rendering. Both are fully testable by mocking `@clack/prompts` with a
 * scripted response queue (including a CANCEL sentinel at any position, for any prompt type), no
 * real TTY required.
 */

const CANCEL = Symbol("cancel");
type Scripted<T> = (T | typeof CANCEL)[];

const state: { select: Scripted<string>; multiselect: Scripted<string[]>; text: Scripted<string> } = { select: [], multiselect: [], text: [] };

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
  text: vi.fn(async () => shift(state.text)),
}));

async function importFresh() {
  vi.resetModules();
  return import("./interactive.js");
}

function reset() {
  state.select = [];
  state.multiselect = [];
  state.text = [];
}

describe("runInteractiveInterview — sequencing + answer mapping (clack mocked)", () => {
  test("a full run through every step, tools=shopify and router=llm and whatsapp=later, produces the expected CompleteInterviewAnswers", async () => {
    reset();
    state.select = ["openai", "none", "shopify", "local", "llm", "later"];
    state.multiselect = [["store-info", "orders"]];
    state.text = ["luna-and-co.myshopify.com"];

    const { runInteractiveInterview } = await importFresh();
    const answers = await runInteractiveInterview();

    expect(answers).toEqual({
      model: { provider: "openai" },
      framework: { framework: "none" },
      skills: { skills: ["store-info", "orders"] },
      tools: { kind: "shopify", storeDomain: "luna-and-co.myshopify.com" },
      memory: { backend: "local" },
      router: { router: "llm" },
      whatsapp: { mode: "later" },
    });
  });

  test("tools=openapi prompts for a source URL/path instead of a Shopify domain", async () => {
    reset();
    state.select = ["openai", "none", "openapi", "local", "llm", "later"];
    state.multiselect = [[]];
    state.text = ["https://api.example.com/openapi.json"];

    const { runInteractiveInterview } = await importFresh();
    const answers = await runInteractiveInterview();
    expect(answers.tools).toEqual({ kind: "openapi", source: "https://api.example.com/openapi.json" });
    expect(answers.skills).toEqual({ skills: [] });
  });

  test("router=jev prompts for a key path; whatsapp=now prompts for all 3 credentials", async () => {
    reset();
    state.select = ["openai", "none", "none", "local", "jev", "now"];
    state.multiselect = [[]];
    state.text = ["/keys/jev.json", "106540352242922", "EAAtest", "my-verify-token"];

    const { runInteractiveInterview } = await importFresh();
    const answers = await runInteractiveInterview();
    expect(answers.router).toEqual({ router: "jev", jevKeyPath: "/keys/jev.json" });
    expect(answers.whatsapp).toEqual({ mode: "now", phoneNumberId: "106540352242922", accessToken: "EAAtest", verifyToken: "my-verify-token" });
  });

  test("an invalid combo (Jev router with an empty key path) re-prompts the whole step, not just re-validated silently", async () => {
    reset();
    // First pass through "router" picks jev with an empty key path (invalid — applyAnswer rejects
    // it); the loop goes back to nextQuestion(), which is STILL "router" (its answer never got
    // applied), so it re-runs the entire step: select again, then text again.
    state.select = ["openai", "none", "none", "local", "jev", "jev", "later"];
    state.multiselect = [[]];
    state.text = ["", "/keys/jev.json"];

    const { runInteractiveInterview } = await importFresh();
    const answers = await runInteractiveInterview();
    expect(answers.router).toEqual({ router: "jev", jevKeyPath: "/keys/jev.json" });
    expect(state.text).toHaveLength(0);
    expect(state.select).toHaveLength(0);
  });
});

describe("runInteractiveInterview — cancellation (clack's isCancel) exits rather than continuing with garbage", () => {
  function mockExit() {
    return vi.spyOn(process, "exit").mockImplementation(((() => {
      throw new Error("process.exit called");
    }) as unknown) as (code?: number) => never);
  }

  test("cancelling the very first select() (the model step)", async () => {
    reset();
    state.select = [CANCEL];
    const exitSpy = mockExit();
    const { runInteractiveInterview } = await importFresh();
    await expect(runInteractiveInterview()).rejects.toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  test("cancelling the skills multiselect()", async () => {
    reset();
    state.select = ["openai", "none"];
    state.multiselect = [CANCEL];
    const exitSpy = mockExit();
    const { runInteractiveInterview } = await importFresh();
    await expect(runInteractiveInterview()).rejects.toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  test("cancelling a text() sub-prompt (the Shopify store domain)", async () => {
    reset();
    state.select = ["openai", "none", "shopify"];
    state.multiselect = [[]];
    state.text = [CANCEL];
    const exitSpy = mockExit();
    const { runInteractiveInterview } = await importFresh();
    await expect(runInteractiveInterview()).rejects.toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});
