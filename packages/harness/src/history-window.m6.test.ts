import { describe, expect, test } from "vitest";
import { fakeMemory } from "@wappy/testkit";
import type { Model, Turn } from "@wappy/core";
import { windowHistory } from "./history-window.js";

function turn(i: number, role: Turn["role"] = "user"): Turn {
  return { id: `t${i}`, contactId: "c1", role, text: `message ${i}`, timestamp: i };
}

const clock = { now: () => 1000, setTimeout: () => 0, clearTimeout: () => {}, sleep: async () => {} };

describe("windowHistory — under the limit", () => {
  test("history at or below maxRecentTurns is returned as-is, with no summary and no model call", async () => {
    const model: Model = { generate: async () => { throw new Error("must not be called"); } };
    const memory = fakeMemory();
    const history = Array.from({ length: 5 }, (_, i) => turn(i));
    const result = await windowHistory({ model, memory, contactId: "c1", history, maxRecentTurns: 10, clock });
    expect(result.summary).toBeUndefined();
    expect(result.recentTurns).toEqual(history);
  });
});

describe("windowHistory — summarizing the oldest chunk", () => {
  test("history exceeding the limit summarizes the oldest turns and keeps only the most recent maxRecentTurns", async () => {
    const model: Model = { generate: async (req) => ({ text: `SUMMARY of: ${req.prompt.length} chars` }) };
    const memory = fakeMemory();
    const history = Array.from({ length: 20 }, (_, i) => turn(i));
    const result = await windowHistory({ model, memory, contactId: "c1", history, maxRecentTurns: 5, clock });
    expect(result.recentTurns).toHaveLength(5);
    expect(result.recentTurns[0]?.id).toBe("t15"); // the 5 most recent
    expect(result.summary).toContain("SUMMARY of:");
  });

  test("the summary is persisted to Memory (as a turn), not just returned", async () => {
    const model: Model = { generate: async () => ({ text: "the summary text" }) };
    const memory = fakeMemory();
    const history = Array.from({ length: 20 }, (_, i) => turn(i));
    await windowHistory({ model, memory, contactId: "c1", history, maxRecentTurns: 5, clock });
    expect(memory.turns.some((t) => t.text === "the summary text")).toBe(true);
  });

  test("a second call with the same history (now including the persisted summary) does NOT re-summarize", async () => {
    const memory = fakeMemory();
    let calls = 0;
    const model: Model = {
      generate: async () => {
        calls++;
        return { text: `summary attempt ${calls}` };
      },
    };
    const history1 = Array.from({ length: 20 }, (_, i) => turn(i));
    const first = await windowHistory({ model, memory, contactId: "c1", history: history1, maxRecentTurns: 5, clock });
    expect(calls).toBe(1);

    // Simulate the caller reloading memory (now containing the persisted summary turn) for the next message.
    const history2 = await memory.load("c1");
    const second = await windowHistory({ model, memory, contactId: "c1", history: history2, maxRecentTurns: 5, clock });
    expect(calls).toBe(1); // no new model call — the persisted summary was reused
    expect(second.summary).toBe(first.summary);
  });

  test("once enough NEW turns accumulate past the last summary, it summarizes again (rolling)", async () => {
    const memory = fakeMemory();
    let calls = 0;
    const model: Model = {
      generate: async () => {
        calls++;
        return { text: `summary #${calls}` };
      },
    };
    const history1 = Array.from({ length: 20 }, (_, i) => turn(i));
    await windowHistory({ model, memory, contactId: "c1", history: history1, maxRecentTurns: 5, clock });
    expect(calls).toBe(1);

    const historyAfterFirst = await memory.load("c1");
    // Append 10 more new turns beyond what was already summarized.
    const moreTurns = Array.from({ length: 10 }, (_, i) => turn(20 + i));
    const history2 = [...historyAfterFirst, ...moreTurns];
    const result = await windowHistory({ model, memory, contactId: "c1", history: history2, maxRecentTurns: 5, clock });
    expect(calls).toBe(2); // summarized again — rolling window
    expect(result.summary).toBe("summary #2");
    expect(result.recentTurns).toHaveLength(5);
    expect(result.recentTurns[result.recentTurns.length - 1]?.id).toBe("t29"); // the newest turn
  });
});

describe("windowHistory — summarizer success, prompt content", () => {
  test("a turn with no text (e.g. media-only) is summarized with a placeholder, not 'undefined'", async () => {
    let seenPrompt = "";
    const model: Model = { generate: async (req) => { seenPrompt = req.prompt; return { text: "summary" }; } };
    const memory = fakeMemory();
    const history = [{ id: "t0", contactId: "c1", role: "user" as const, timestamp: 0 }, ...Array.from({ length: 19 }, (_, i) => turn(i + 1))];
    await windowHistory({ model, memory, contactId: "c1", history, maxRecentTurns: 5, clock });
    expect(seenPrompt).toContain("(no text)");
  });
});

// On summarizer failure (thrown error or degenerate empty response), falls back to plain truncation
// (§10/T6.3): recentTurns is still capped to maxRecentTurns, exactly like the success path — but
// nothing is persisted to Memory, since marking the older turns "covered" by a content-free
// placeholder would be permanent and unrecoverable. The next call therefore retries from scratch.
describe("windowHistory — summarizer failure: plain truncation, no persistence, retry-able", () => {
  test("the model throwing never crashes, falls back to plain truncation (capped to maxRecentTurns)", async () => {
    const model: Model = { generate: async () => { throw new Error("model down"); } };
    const memory = fakeMemory();
    const history = Array.from({ length: 20 }, (_, i) => turn(i));
    const result = await windowHistory({ model, memory, contactId: "c1", history, maxRecentTurns: 5, clock });
    expect(result.recentTurns).toHaveLength(5);
    expect(result.recentTurns[0]?.id).toBe("t15"); // the 5 most recent, same slice the success path would keep
    expect(result.summary).toBeUndefined(); // no prior summary existed, and nothing was persisted now
  });

  test("the model returning empty text is treated the same as a thrown error — plain truncation, no persistence", async () => {
    const model: Model = { generate: async () => ({ text: "" }) };
    const memory = fakeMemory();
    const history = Array.from({ length: 20 }, (_, i) => turn(i));
    const result = await windowHistory({ model, memory, contactId: "c1", history, maxRecentTurns: 5, clock });
    expect(result.recentTurns).toHaveLength(5);
    expect(result.summary).toBeUndefined();
  });

  test("nothing is appended to Memory on a summarizer failure", async () => {
    const model: Model = { generate: async () => { throw new Error("model down"); } };
    const memory = fakeMemory();
    const history = Array.from({ length: 20 }, (_, i) => turn(i));
    await windowHistory({ model, memory, contactId: "c1", history, maxRecentTurns: 5, clock });
    expect(memory.turns).toHaveLength(0);
  });

  test("a transient failure doesn't block a later successful summarization — the next call retries from scratch", async () => {
    const memory = fakeMemory();
    let calls = 0;
    const model: Model = {
      generate: async () => {
        calls++;
        if (calls === 1) throw new Error("model down");
        return { text: "recovered summary" };
      },
    };
    const history = Array.from({ length: 20 }, (_, i) => turn(i));
    const first = await windowHistory({ model, memory, contactId: "c1", history, maxRecentTurns: 5, clock });
    expect(first.summary).toBeUndefined();
    expect(first.recentTurns).toHaveLength(5); // plain truncation fallback, not the full unsummarized set
    expect(calls).toBe(1);

    const second = await windowHistory({ model, memory, contactId: "c1", history, maxRecentTurns: 5, clock });
    expect(calls).toBe(2); // retried — no placeholder was persisted to short-circuit this
    expect(second.summary).toBe("recovered summary");
    expect(second.recentTurns).toHaveLength(5);
  });

  test("an existing PRIOR summary is preserved (not wiped) when a later rolling summarization attempt fails", async () => {
    const memory = fakeMemory();
    let calls = 0;
    const model: Model = {
      generate: async () => {
        calls++;
        if (calls === 1) return { text: "first summary" };
        throw new Error("model down");
      },
    };
    const history1 = Array.from({ length: 20 }, (_, i) => turn(i));
    const first = await windowHistory({ model, memory, contactId: "c1", history: history1, maxRecentTurns: 5, clock });
    expect(first.summary).toBe("first summary");

    const historyAfterFirst = await memory.load("c1");
    const moreTurns = Array.from({ length: 10 }, (_, i) => turn(20 + i));
    const history2 = [...historyAfterFirst, ...moreTurns];
    const second = await windowHistory({ model, memory, contactId: "c1", history: history2, maxRecentTurns: 5, clock });
    expect(second.summary).toBe("first summary"); // the earlier, still-persisted summary survives
  });
});

// Milestone brief's required scale fixture: a 10,000-turn history (e.g. an imported/long-lived
// contact never summarized before) must not blow up in latency or size — the function's own work is
// linear in history length (one findIndex + one filter + one slice), not quadratic or unbounded.
// A dedicated clock whose `now()` is past every fixture turn's timestamp (0..9999) — fakeMemory's
// load() sorts by timestamp, so a persisted summary turn must sort AFTER everything it covers, or a
// reload would see it appear mid-history instead of at the end.
const lateClock = { now: () => 20_000, setTimeout: () => 0, clearTimeout: () => {}, sleep: async () => {} };

describe("windowHistory — 10,000-turn history fixture (bounded latency and size)", () => {
  test("completes in bounded time and correctly caps recentTurns to maxRecentTurns", async () => {
    const memory = fakeMemory();
    const model: Model = { generate: async () => ({ text: "summary of a very long history" }) };
    const history = Array.from({ length: 10_000 }, (_, i) => turn(i));
    const start = Date.now();
    const result = await windowHistory({ model, memory, contactId: "c1", history, maxRecentTurns: 20, clock: lateClock });
    const elapsedMs = Date.now() - start;
    expect(result.recentTurns).toHaveLength(20);
    expect(result.recentTurns[result.recentTurns.length - 1]?.id).toBe("t9999"); // the newest turn
    expect(result.summary).toBe("summary of a very long history");
    expect(elapsedMs).toBeLessThan(2000); // generous bound — proves no accidental quadratic blowup
  });

  test("a second call reusing the history (now including the persisted summary) does not re-summarize, even at this scale", async () => {
    const memory = fakeMemory();
    let calls = 0;
    const model: Model = { generate: async () => { calls++; return { text: `summary attempt ${calls}` }; } };
    const history = Array.from({ length: 10_000 }, (_, i) => turn(i));
    // Mirrors real usage (agent.ts persists every turn via Memory.append before windowing it) — the
    // original 20-turn variant of this test above skips this, which happens to still pass there only
    // because it never asserts on recentTurns after the reload; asserting it at this scale requires
    // the fixture to actually match how Memory is populated in production.
    for (const t of history) await memory.append(t);
    const first = await windowHistory({ model, memory, contactId: "c1", history, maxRecentTurns: 20, clock: lateClock });
    expect(calls).toBe(1);

    const historyAfterFirst = await memory.load("c1");
    const second = await windowHistory({ model, memory, contactId: "c1", history: historyAfterFirst, maxRecentTurns: 20, clock: lateClock });
    expect(calls).toBe(1); // no new model call — the persisted summary was reused
    expect(second.summary).toBe(first.summary);
    expect(second.recentTurns).toHaveLength(20);
    expect(second.recentTurns[second.recentTurns.length - 1]?.id).toBe("t9999");
  });
});
