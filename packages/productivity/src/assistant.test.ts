import { describe, expect, test } from "vitest";
import type { InboundMessage, Model, ModelRequest, ModelResult } from "@wappy_ai/core";
import { createGoogleAssistant } from "./assistant.js";

/** v3: no saved tasks, no fixed templates — any message that plausibly needs Gmail/Calendar gets
 * offered two generic tools. `@wappy_ai/harness`'s real `createVercelModel` calls `execute()` itself
 * and loops internally (confirmed by reading model.ts directly), so these tests use a small
 * hand-rolled fake `Model` that does the same — calling requested tools for real — rather than
 * testkit's `mockModel()`, which never invokes `Tool.execute()` at all (it just replays scripted
 * steps as data). */

function inbound(text: string, contactId = "+1"): InboundMessage {
  return { id: "m1", contactId, channel: "fake", text, timestamp: 1000, raw: {} };
}

/** Simulates what `createVercelModel` really does: if `callTools` names are given, invokes each
 * matching tool from `req.tools` for real (so the assistant's own `usedAnyTool` tracking fires
 * exactly like it would in production), then returns `finalText`. Empty `callTools` mirrors "the
 * model decided this wasn't relevant" — no tool ever touched. */
function fakeToolCallingModel(opts: { callTools?: { name: string; args?: unknown }[]; finalText?: string; throwOnGenerate?: boolean }): Model {
  return {
    async generate(req: ModelRequest): Promise<ModelResult> {
      if (opts.throwOnGenerate) throw new Error("model is down");
      for (const call of opts.callTools ?? []) {
        const tool = req.tools?.find((t) => t.name === call.name);
        await tool?.execute(call.args ?? {});
      }
      return { text: opts.finalText ?? "" };
    },
  };
}

describe("createGoogleAssistant", () => {
  test("no connectors configured at all -> handled:false immediately, no model call", async () => {
    let called = false;
    const model: Model = {
      async generate() {
        called = true;
        return { text: "x" };
      },
    };
    const assistant = createGoogleAssistant({ model, clock: { now: () => 0 } });
    const result = await assistant.maybeHandle(inbound("what's on my calendar"));
    expect(result).toEqual({ handled: false });
    expect(called).toBe(false);
  });

  test("the model deciding a message doesn't need Gmail/Calendar -> handled:false, no reply used", async () => {
    const model = fakeToolCallingModel({ finalText: "irrelevant text the router should discard" });
    const gmail = async () => "unused";
    const assistant = createGoogleAssistant({ model, clock: { now: () => 0 }, connectors: { gmail } });
    const result = await assistant.maybeHandle(inbound("hey what's up"));
    expect(result).toEqual({ handled: false });
  });

  test("a real Gmail search request runs the tool and returns the model's composed reply", async () => {
    const gmail = async (args: { query?: string }) => {
      expect(args.query).toContain("is:unread");
      return "1. Invoice — from billing@x.com";
    };
    const model = fakeToolCallingModel({ callTools: [{ name: "search_gmail", args: { query: "is:unread" } }], finalText: "You have 1 unread email: an invoice." });
    const assistant = createGoogleAssistant({ model, clock: { now: () => 0 }, connectors: { gmail } });
    const result = await assistant.maybeHandle(inbound("summarize my unread emails"));
    expect(result).toEqual({ handled: true, reply: "You have 1 unread email: an invoice." });
  });

  test("a real Calendar search request runs the tool and returns the model's composed reply", async () => {
    const calendar = async () => "1. Standup — 9am";
    const model = fakeToolCallingModel({ callTools: [{ name: "search_calendar", args: {} }], finalText: "You have a standup at 9am." });
    const assistant = createGoogleAssistant({ model, clock: { now: () => 0 }, connectors: { calendar } });
    const result = await assistant.maybeHandle(inbound("what's on my calendar today"));
    expect(result).toEqual({ handled: true, reply: "You have a standup at 9am." });
  });

  test("only the connectors actually configured get offered as tools", async () => {
    let sawTools: string[] = [];
    const model: Model = {
      async generate(req) {
        sawTools = (req.tools ?? []).map((t) => t.name);
        return { text: "ok" };
      },
    };
    const gmail = async () => "unused";
    const assistant = createGoogleAssistant({ model, clock: { now: () => 0 }, connectors: { gmail } }); // no calendar
    await assistant.maybeHandle(inbound("anything"));
    expect(sawTools).toEqual(["search_gmail"]);
  });

  test("a model error before any tool ran falls back to handled:false, not a crash", async () => {
    const model = fakeToolCallingModel({ throwOnGenerate: true });
    const gmail = async () => "unused";
    const assistant = createGoogleAssistant({ model, clock: { now: () => 0 }, connectors: { gmail } });
    const result = await assistant.maybeHandle(inbound("summarize my emails"));
    expect(result).toEqual({ handled: false });
  });

  test("an empty/whitespace message never calls the model", async () => {
    let called = false;
    const model: Model = {
      async generate() {
        called = true;
        return { text: "x" };
      },
    };
    const gmail = async () => "unused";
    const assistant = createGoogleAssistant({ model, clock: { now: () => 0 }, connectors: { gmail } });
    const result = await assistant.maybeHandle(inbound("   "));
    expect(result).toEqual({ handled: false });
    expect(called).toBe(false);
  });

  test("a tool that itself errors is reported to the model as ok:false, not thrown out of maybeHandle", async () => {
    const gmail = async () => {
      throw new Error("Gmail API is down");
    };
    const model = fakeToolCallingModel({ callTools: [{ name: "search_gmail", args: {} }], finalText: "I couldn't reach Gmail just now — try again in a bit." });
    const assistant = createGoogleAssistant({ model, clock: { now: () => 0 }, connectors: { gmail } });
    const result = await assistant.maybeHandle(inbound("check my email"));
    expect(result).toEqual({ handled: true, reply: "I couldn't reach Gmail just now — try again in a bit." });
  });

  test("the system preamble states read-only scope, today's date, and the open-source decline-warmly instruction", async () => {
    let sawSystem = "";
    const model: Model = {
      async generate(req) {
        sawSystem = req.system ?? "";
        return { text: "ok" };
      },
    };
    const gmail = async () => "unused";
    const assistant = createGoogleAssistant({ model, clock: { now: () => new Date("2026-09-29T12:00:00Z").getTime() }, connectors: { gmail } });
    await assistant.maybeHandle(inbound("anything"));
    expect(sawSystem).toContain("READ");
    expect(sawSystem).toContain("2026-09-29");
    expect(sawSystem).toContain("open-source");
  });

  test("a reply that's still empty after a real tool call is an honest fallback, not a blank message", async () => {
    const gmail = async () => "1. Something";
    const model = fakeToolCallingModel({ callTools: [{ name: "search_gmail", args: {} }], finalText: "" });
    const assistant = createGoogleAssistant({ model, clock: { now: () => 0 }, connectors: { gmail } });
    const result = await assistant.maybeHandle(inbound("summarize my emails"));
    expect(result.handled).toBe(true);
    expect(result.reply).toBeTruthy();
  });
});
