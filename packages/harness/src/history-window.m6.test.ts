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

describe("windowHistory — summarizer failure fallback", () => {
  test("the model throwing falls back to plain truncation, never crashes, still returns recentTurns", async () => {
    const model: Model = { generate: async () => { throw new Error("model down"); } };
    const memory = fakeMemory();
    const history = Array.from({ length: 20 }, (_, i) => turn(i));
    const result = await windowHistory({ model, memory, contactId: "c1", history, maxRecentTurns: 5, clock });
    expect(result.recentTurns).toHaveLength(5);
    expect(result.summary).toBeTruthy(); // an honest fallback summary, not empty/undefined
  });

  test("the fallback summary uses singular 'message' when only one turn needed summarizing", async () => {
    const model: Model = { generate: async () => { throw new Error("model down"); } };
    const memory = fakeMemory();
    const history = Array.from({ length: 6 }, (_, i) => turn(i)); // 6 total, maxRecentTurns 5 -> exactly 1 to summarize
    const result = await windowHistory({ model, memory, contactId: "c1", history, maxRecentTurns: 5, clock });
    expect(result.summary).toContain("1 earlier message ");
    expect(result.summary).not.toContain("messages");
  });

  test("a turn with no text (e.g. media-only) is summarized with a placeholder, not 'undefined'", async () => {
    let seenPrompt = "";
    const model: Model = { generate: async (req) => { seenPrompt = req.prompt; return { text: "summary" }; } };
    const memory = fakeMemory();
    const history = [{ id: "t0", contactId: "c1", role: "user" as const, timestamp: 0 }, ...Array.from({ length: 19 }, (_, i) => turn(i + 1))];
    await windowHistory({ model, memory, contactId: "c1", history, maxRecentTurns: 5, clock });
    expect(seenPrompt).toContain("(no text)");
  });

  test("the model returning empty text also falls back to plain truncation", async () => {
    const model: Model = { generate: async () => ({ text: "" }) };
    const memory = fakeMemory();
    const history = Array.from({ length: 20 }, (_, i) => turn(i));
    const result = await windowHistory({ model, memory, contactId: "c1", history, maxRecentTurns: 5, clock });
    expect(result.summary).toBeTruthy();
  });
});
