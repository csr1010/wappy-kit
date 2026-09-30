import { describe, expect, test } from "vitest";
import { mockModel } from "@wappy_ai/testkit";
import type { InboundMessage } from "@wappy_ai/core";
import { createTaskRouter } from "./router.js";
import { createTaskStore } from "./store.js";

/** v2 (plan pivot: "we should not setup cron or templates... a router should know which task to
 * pick, based on the chat thread"). No fake timers needed — this is a plain per-message match, no
 * background loop. */

function freshStore() {
  return createTaskStore({ url: ":memory:" });
}

function inbound(text: string, contactId = "+15550001111"): InboundMessage {
  return { id: "m1", contactId, channel: "fake", text, timestamp: 1000, raw: {} };
}

describe("createTaskRouter", () => {
  test("a contact with no saved tasks never calls the model — returns handled:false immediately", async () => {
    const store = freshStore();
    const model = mockModel([]); // an empty script — any generate() call would throw "script exhausted"
    const router = createTaskRouter({ store, model });

    const result = await router.maybeHandle(inbound("what's on my calendar"));

    expect(result).toEqual({ handled: false });
    expect(model.calls).toHaveLength(0);
  });

  test("a confident match runs the matched task's instructions against fetched connector data", async () => {
    const store = freshStore();
    const created = await store.create(
      { contactId: "+1", templateId: "daily_meetings", title: "Send me my meetings for today", placeholders: { when: "" } },
      1000,
    );
    const model = mockModel([{ structured: { taskId: created.id, confidence: 0.9 } }, { text: "You have 2 meetings today: standup at 9, review at 2." }]);
    const calendar = async () => "9am standup\n2pm review";
    const router = createTaskRouter({ store, model, connectors: { calendar } });

    const result = await router.maybeHandle(inbound("what's on my calendar today", "+1"));

    expect(result).toEqual({ handled: true, reply: "You have 2 meetings today: standup at 9, review at 2.", taskId: created.id });
    expect(model.calls).toHaveLength(2);
    expect(model.calls[1]!.prompt).toContain("9am standup");
  });

  test("a low-confidence match is treated as no match — never guesses", async () => {
    const store = freshStore();
    await store.create({ contactId: "+1", templateId: "daily_meetings", title: "Send me my meetings for today", placeholders: {} }, 1000);
    const model = mockModel([{ structured: { taskId: "not-real", confidence: 0.2 } }]);
    const router = createTaskRouter({ store, model, matchThreshold: 0.6 });

    const result = await router.maybeHandle(inbound("hey what's up", "+1"));

    expect(result).toEqual({ handled: false });
  });

  test("taskId: null means no match", async () => {
    const store = freshStore();
    await store.create({ contactId: "+1", templateId: "daily_meetings", title: "Send me my meetings for today", placeholders: {} }, 1000);
    const model = mockModel([{ structured: { taskId: null, confidence: 0.9 } }]);
    const router = createTaskRouter({ store, model });

    const result = await router.maybeHandle(inbound("tell me a joke", "+1"));

    expect(result).toEqual({ handled: false });
  });

  test("a model error during matching falls back to handled:false instead of throwing", async () => {
    const store = freshStore();
    await store.create({ contactId: "+1", templateId: "daily_meetings", title: "Send me my meetings for today", placeholders: {} }, 1000);
    const model = mockModel([{ error: new Error("model is down") }]);
    const router = createTaskRouter({ store, model });

    const result = await router.maybeHandle(inbound("what's on my calendar", "+1"));

    expect(result).toEqual({ handled: false });
  });

  test("the contact's exact live wording reaches the compose step, not just the task's fixed instructions", async () => {
    const store = freshStore();
    const created = await store.create({ contactId: "+1", templateId: "summarize_emails", title: "Summarize my unread emails from anyone", placeholders: { from: "" } }, 1000);
    const model = mockModel([{ structured: { taskId: created.id, confidence: 0.9 } }, { text: "Grouped by topic: ..." }]);
    const gmail = async () => "1. Invoice due — from billing@x.com\n2. Team offsite — from hr@x.com";
    const router = createTaskRouter({ store, model, connectors: { gmail } });

    await router.maybeHandle(inbound("summarize my emails by topic in the last 2 days", "+1"));

    expect(model.calls[1]!.prompt).toContain("summarize my emails by topic in the last 2 days");
  });

  test("a gmail-templated task with no gmail connector configured still composes an honest 'not connected' reply", async () => {
    const store = freshStore();
    const created = await store.create({ contactId: "+1", templateId: "summarize_emails", title: "Summarize my unread emails from anyone", placeholders: {} }, 1000);
    const model = mockModel([{ structured: { taskId: created.id, confidence: 0.8 } }, { text: "Gmail isn't connected yet — connect it from your task list to use this." }]);
    const router = createTaskRouter({ store, model }); // no connectors passed at all

    const result = await router.maybeHandle(inbound("summarize my emails", "+1"));

    expect(result.handled).toBe(true);
    expect(model.calls[1]!.prompt).toContain("Gmail isn't connected yet.");
  });

  test("an empty/whitespace-only message never calls the model", async () => {
    const store = freshStore();
    await store.create({ contactId: "+1", templateId: "daily_meetings", title: "x", placeholders: {} }, 1000);
    const model = mockModel([]);
    const router = createTaskRouter({ store, model });

    const result = await router.maybeHandle(inbound("   ", "+1"));

    expect(result).toEqual({ handled: false });
    expect(model.calls).toHaveLength(0);
  });
});
