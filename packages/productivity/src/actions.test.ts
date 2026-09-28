import { describe, expect, test } from "vitest";
import { DEFAULT_ACTIONS, reminderAction, wakeMeUpAction } from "./actions.js";
import type { Task } from "./store.js";

/** Phase 3 (plan: "Real actions: reminder + wake-me-up, honest stubs for the rest"). */

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    contactId: "+15550001111",
    templateId: "reminder",
    title: "Remind me",
    placeholders: {},
    scheduleKind: "dailyAt",
    scheduleValue: "09:00",
    status: "on",
    retryCount: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const ctx = { siblingTasks: [] };

describe("reminderAction", () => {
  test("includes the reminder text placeholder in the message", async () => {
    const result = await reminderAction(task({ placeholders: { text: "call mom", time: "17:00" } }), ctx);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("call mom");
  });

  test("falls back gracefully if the text placeholder is somehow missing", async () => {
    const result = await reminderAction(task({ placeholders: {} }), ctx);
    expect(result.ok).toBe(true);
    expect(result.message).toBeTruthy();
  });
});

describe("wakeMeUpAction", () => {
  test("returns a real wake-up message", async () => {
    const result = await wakeMeUpAction(task({ templateId: "wake_me_up" }), ctx);
    expect(result.ok).toBe(true);
    expect(result.message.toLowerCase()).toContain("wake up");
  });
});

describe("the 3 Google-backed stubs", () => {
  test.each(["daily_meetings", "summarize_emails", "find_emails"] as const)("%s replies honestly that Google isn't connected, never a fabricated result", async (templateId) => {
    const result = await DEFAULT_ACTIONS[templateId](task({ templateId }), ctx);
    expect(result.ok).toBe(true); // an honest stub is a successful call, not a failure/retry trigger
    expect(result.message.toLowerCase()).toContain("google");
  });
});

describe("DEFAULT_ACTIONS", () => {
  test("has an entry for every template id", () => {
    expect(Object.keys(DEFAULT_ACTIONS).sort()).toEqual(["daily_meetings", "find_emails", "reminder", "summarize_emails", "wake_me_up"]);
  });
});
