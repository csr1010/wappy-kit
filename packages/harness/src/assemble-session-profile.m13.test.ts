import { describe, expect, test } from "vitest";
import { assemblePrompt } from "./assemble.js";
import { createContextBudget } from "./context-budget.js";

const budget = createContextBudget("gpt-4o-mini", { overrides: { contextWindow: 2_000, reservedOutputTokens: 0 } });

/**
 * M13: a new, optional `sessionProfile` section — a pre-rendered text block the caller (agent.ts)
 * builds from a `SessionProfile`. Kept as a plain string here (like `summary`) rather than
 * importing `@wappy/core`'s `SessionProfile` type, so this module stays decoupled from any one
 * caller's shape — same pattern `summary` already follows.
 */
describe("assemblePrompt — sessionProfile section (M13)", () => {
  test("appears right after system, before skillFragments", () => {
    const result = assemblePrompt(
      { system: "SYS", sessionProfile: "PROFILE", skillFragments: ["SKILL"], userMessage: "USER" },
      budget,
    );
    const order = ["SYS", "PROFILE", "SKILL", "USER"];
    let lastIndex = -1;
    for (const marker of order) {
      const idx = result.prompt.indexOf(marker);
      expect(idx).toBeGreaterThan(lastIndex);
      lastIndex = idx;
    }
  });

  test("omitted when not provided — no empty placeholder", () => {
    const result = assemblePrompt({ system: "SYS", userMessage: "USER" }, budget);
    expect(result.prompt).toBe("SYS\n\nUSER");
  });

  test("a profile block far exceeding its own cap is truncated, not left whole", () => {
    const tinyBudget = createContextBudget("x", { overrides: { contextWindow: 200, reservedOutputTokens: 0 } });
    const result = assemblePrompt({ system: "SYS", sessionProfile: "P".repeat(5000), userMessage: "USER" }, tinyBudget);
    expect(result.usage.sessionProfile).toBeLessThanOrEqual(Math.floor(tinyBudget.promptBudget * 0.1));
  });

  test("under pressure severe enough to drop it, recentTurns (highest priority) is still standing", () => {
    const microBudget = createContextBudget("x", { overrides: { contextWindow: 9, reservedOutputTokens: 0 } });
    const result = assemblePrompt(
      {
        system: "S",
        sessionProfile: "the session profile block, long enough to matter",
        recentTurns: [{ id: "t1", contactId: "c1", role: "user", text: "h", timestamp: 1 }],
        userMessage: "U",
      },
      microBudget,
    );
    expect(result.dropped).toContain("sessionProfile");
    expect(result.dropped).not.toContain("recentTurns");
    expect(result.prompt).toContain("user: h"); // the recent turn survived
  });
});
