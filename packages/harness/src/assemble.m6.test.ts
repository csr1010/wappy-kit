import { describe, expect, test } from "vitest";
import type { Turn } from "@wappy/core";
import { assemblePrompt } from "./assemble.js";
import { createContextBudget } from "./context-budget.js";

const budget = createContextBudget("gpt-4o-mini", { overrides: { contextWindow: 2_000, reservedOutputTokens: 0 } });

function turn(i: number, role: Turn["role"] = "user"): Turn {
  return { id: `t${i}`, contactId: "c1", role, text: `message number ${i}`, timestamp: i };
}

describe("assemblePrompt — ordering and inclusion", () => {
  test("sections appear in the fixed order: system, skills, tools, summary, recalled, recent turns, user message", () => {
    const result = assemblePrompt(
      {
        system: "SYS",
        skillFragments: ["SKILL"],
        toolSchemas: ["TOOL"],
        summary: "SUMMARY",
        recalledSnippets: ["RECALL"],
        recentTurns: [turn(1)],
        userMessage: "USER",
      },
      budget,
    );
    const order = ["SYS", "SKILL", "TOOL", "SUMMARY", "RECALL", "message number 1", "USER"];
    let lastIndex = -1;
    for (const marker of order) {
      const idx = result.prompt.indexOf(marker);
      expect(idx).toBeGreaterThan(lastIndex);
      lastIndex = idx;
    }
  });

  test("with only system + user message, both are present and nothing else", () => {
    const result = assemblePrompt({ system: "SYS", userMessage: "USER" }, budget);
    expect(result.prompt).toBe("SYS\n\nUSER");
    expect(result.dropped).toEqual([]);
  });

  test("an omitted optional section is simply absent, not an empty placeholder", () => {
    const result = assemblePrompt({ system: "SYS", summary: "SUMMARY", userMessage: "USER" }, budget);
    expect(result.prompt).toBe("SYS\n\nSUMMARY\n\nUSER");
  });
});

describe("assemblePrompt — per-section caps", () => {
  test("a section far exceeding its own cap is truncated, not left whole (stable prefix, bounded size)", () => {
    const tinyBudget = createContextBudget("x", { overrides: { contextWindow: 200, reservedOutputTokens: 0 } });
    const result = assemblePrompt({ system: "SYS", summary: "S".repeat(5000), userMessage: "USER" }, tinyBudget);
    expect(result.usage.summary).toBeLessThanOrEqual(Math.floor(tinyBudget.promptBudget * 0.05));
  });

  test("a summary whose cap floors to zero tokens is dropped entirely, not left as a truncated fragment", () => {
    const microBudget = createContextBudget("x", { overrides: { contextWindow: 15, reservedOutputTokens: 0 } }); // 15*0.05 floors to 0
    const result = assemblePrompt({ system: "SYS", summary: "a summary that would otherwise appear", userMessage: "USER" }, microBudget);
    expect(result.prompt).not.toContain("summary");
    expect(result.dropped).toContain("summary");
  });

  test("a recent turn with no text (e.g. media-only) renders with a placeholder instead of 'undefined'", () => {
    const result = assemblePrompt({ system: "SYS", recentTurns: [{ id: "t1", contactId: "c1", role: "user", timestamp: 0 }], userMessage: "USER" }, budget);
    expect(result.prompt).toContain("(no text)");
  });

  test("recentTurns drops the OLDEST turns first, keeping the most recent", () => {
    const tinyBudget = createContextBudget("x", { overrides: { contextWindow: 400, reservedOutputTokens: 0 } });
    const turns = Array.from({ length: 50 }, (_, i) => turn(i));
    const result = assemblePrompt({ system: "SYS", recentTurns: turns, userMessage: "USER" }, tinyBudget);
    expect(result.prompt).toContain("message number 49"); // most recent survives
    expect(result.prompt).not.toContain("message number 0"); // oldest was dropped
  });

  test("recalledSnippets drops from the END (least relevant), keeping the most relevant (first) ones", () => {
    const tinyBudget = createContextBudget("x", { overrides: { contextWindow: 400, reservedOutputTokens: 0 } });
    const snippets = Array.from({ length: 50 }, (_, i) => `snippet-${i}-most-relevant-first-${"x".repeat(20)}`);
    const result = assemblePrompt({ system: "SYS", recalledSnippets: snippets, userMessage: "USER" }, tinyBudget);
    expect(result.prompt).toContain("snippet-0-"); // most relevant (first) survives
    expect(result.prompt).not.toContain("snippet-49-"); // least relevant (last) was dropped
  });
});

describe("assemblePrompt — whole-section dropping under extreme pressure", () => {
  test("when even capped sections don't fit, whole sections drop lowest-priority-first, never system/userMessage", () => {
    const microBudget = createContextBudget("x", { overrides: { contextWindow: 20, reservedOutputTokens: 0 } });
    const result = assemblePrompt(
      {
        system: "SYS",
        skillFragments: ["skill fragment text here"],
        toolSchemas: ["tool schema text here"],
        summary: "a summary of history",
        recalledSnippets: ["a recalled snippet"],
        recentTurns: [turn(1), turn(2)],
        userMessage: "USER",
      },
      microBudget,
    );
    expect(result.prompt).toContain("SYS");
    expect(result.prompt).toContain("USER");
    expect(result.dropped).toContain("recalledSnippets"); // lowest priority, dropped first
  });

  test("a section already emptied by its own per-section cap is skipped (not double-reported) as the drop loop continues to the next lowest-priority section", () => {
    // Mandatory system+userMessage are large enough alone to exceed the budget (never capped/dropped,
    // so this is unavoidable here) — the point is to prove the drop loop still runs cleanly to
    // completion without double-counting a section phase 1 already emptied.
    const microBudget = createContextBudget("x", { overrides: { contextWindow: 20, reservedOutputTokens: 0 } });
    const result = assemblePrompt(
      {
        system: "S".repeat(60),
        toolSchemas: ["short"], // fits its own (larger, 20%) cap, survives phase 1
        recalledSnippets: ["a fairly long recalled snippet of text"], // exceeds its own (smaller, 10%) cap, emptied in phase 1
        userMessage: "U".repeat(60),
      },
      microBudget,
    );
    expect(result.dropped).toEqual(["recalledSnippets", "toolSchemas"]); // each name appears exactly once, in priority order
  });

  test("dropped sections are reported by name", () => {
    const microBudget = createContextBudget("x", { overrides: { contextWindow: 15, reservedOutputTokens: 0 } });
    const result = assemblePrompt({ system: "SYS", recalledSnippets: ["a fairly long recalled snippet of text"], userMessage: "USER" }, microBudget);
    expect(result.dropped).toEqual(["recalledSnippets"]);
    expect(result.prompt).not.toContain("recalled snippet");
  });
});

describe("assemblePrompt — determinism", () => {
  test("the same input always produces byte-identical output (stable prefix, prompt-cache friendly)", () => {
    const input = { system: "SYS", skillFragments: ["A", "B"], recentTurns: [turn(1), turn(2)], userMessage: "USER" };
    const a = assemblePrompt(input, budget);
    const b = assemblePrompt(input, budget);
    expect(a.prompt).toBe(b.prompt);
  });
});

describe("assemblePrompt — property test: random inputs never exceed budget, always keep system + user", () => {
  test("1000 random histories/tool-sets/skill-sizes all assemble within budget and never drop system/userMessage", () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const randInt = (max: number) => Math.floor(rand() * max);
    const randText = (maxLen: number) => "w".repeat(randInt(maxLen) + 1) + " ".repeat(randInt(5));

    for (let trial = 0; trial < 1000; trial++) {
      // Minimum stays comfortably above the largest possible mandatory system+userMessage size (never
      // dropped/truncated) so the budget-fits assertion below isn't testing an inherently-impossible case.
      const testBudget = createContextBudget("x", { overrides: { contextWindow: 200 + randInt(5000), reservedOutputTokens: 0 } });
      const input = {
        system: randText(50),
        skillFragments: Array.from({ length: randInt(5) }, () => randText(200)),
        toolSchemas: Array.from({ length: randInt(20) }, () => randText(300)),
        summary: rand() > 0.5 ? randText(500) : undefined,
        recalledSnippets: Array.from({ length: randInt(10) }, () => randText(200)),
        recentTurns: Array.from({ length: randInt(50) }, (_, i) => turn(i)),
        userMessage: randText(100),
      };
      const result = assemblePrompt(input, testBudget);
      expect(result.prompt).toContain(input.system);
      expect(result.prompt).toContain(input.userMessage);
      expect(testBudget.estimator.estimate(result.prompt)).toBeLessThanOrEqual(testBudget.promptBudget);
    }
  });
});
