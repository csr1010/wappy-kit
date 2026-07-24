import { describe, expect, test } from "vitest";
import type { Memory, MessageChannel, Router, ToolProvider } from "@wappy/core";
import { fakeChannel, fakeMemory, fakeRouter, fakeToolProvider } from "./fakes.js";
import { runChannelConformance, runMemoryConformance, runRouterConformance, runToolProviderConformance } from "./conformance.js";

describe("fakeChannel", () => {
  test("passes channel conformance", async () => {
    const violations = await runChannelConformance(fakeChannel(), {
      rawWithMessage: { text: "hi" },
      rawStatusOnly: { statusOnly: true },
      to: "c1",
      message: { text: "hello" },
    });
    expect(violations).toEqual([]);
  });

  test("records sends and lets failures/fallbacks be scripted", async () => {
    const ch = fakeChannel();
    ch.failNextSend("fellBack", "buttons rejected");
    const r1 = await ch.send("c1", { text: "hi" });
    expect(r1).toEqual({ status: "fellBack", reason: "buttons rejected" });
    const r2 = await ch.send("c1", { text: "hi again" });
    expect(r2.status).toBe("sent");
    expect(ch.sent).toHaveLength(2);
  });

  test("a broken channel (bad DeliveryResult) fails conformance", async () => {
    const broken: MessageChannel = {
      name: "broken",
      receive: () => [],
      // @ts-expect-error deliberately invalid: failed with no reason
      send: async () => ({ status: "failed" }),
    };
    const violations = await runChannelConformance(broken, { rawWithMessage: { text: "hi" }, to: "c1", message: { text: "hi" } });
    expect(violations.join("\n")).toMatch(/not a valid DeliveryResult/);
  });

  test("a broken channel (receive() not an array) fails conformance", async () => {
    const broken: MessageChannel = {
      name: "broken",
      // @ts-expect-error deliberately invalid
      receive: () => "nope",
      send: async () => ({ status: "sent" }),
    };
    const violations = await runChannelConformance(broken, { rawWithMessage: { text: "hi" }, to: "c1", message: { text: "hi" } });
    expect(violations).toContain("receive() must return an array");
  });

  test("receive(null/undefined) returns no messages", () => {
    const ch = fakeChannel();
    expect(ch.receive(null)).toEqual([]);
    expect(ch.receive(undefined)).toEqual([]);
  });

  test("a channel with an empty name fails conformance", async () => {
    const broken: MessageChannel = { name: "", receive: () => [], send: async () => ({ status: "sent" }) };
    const violations = await runChannelConformance(broken, { rawWithMessage: { text: "hi" }, to: "c1", message: { text: "hi" } });
    expect(violations).toContain("MessageChannel.name must be a non-empty string");
  });

  test("a channel whose receive() yields a malformed InboundMessage fails conformance", async () => {
    const broken: MessageChannel = {
      name: "broken",
      // @ts-expect-error deliberately invalid: missing required fields
      receive: () => [{ text: "hi" }],
      send: async () => ({ status: "sent" }),
    };
    const violations = await runChannelConformance(broken, { rawWithMessage: {}, to: "c1", message: { text: "hi" } });
    expect(violations.join("\n")).toMatch(/not a valid InboundMessage/);
  });

  test("a channel whose receive(rawStatusOnly) isn't empty fails conformance", async () => {
    const broken: MessageChannel = {
      name: "broken",
      receive: () => [{ id: "1", contactId: "c1", channel: "x", timestamp: 0 }],
      send: async () => ({ status: "sent" }),
    };
    const violations = await runChannelConformance(broken, { rawWithMessage: {}, rawStatusOnly: { statusOnly: true }, to: "c1", message: { text: "hi" } });
    expect(violations).toContain("receive(rawStatusOnly) must return an empty array");
  });
});

describe("fakeMemory", () => {
  test("passes memory conformance", async () => {
    const violations = await runMemoryConformance(fakeMemory(), {
      contactId: "c1",
      turn: { id: "t1", contactId: "c1", role: "user", text: "hi", timestamp: 0 },
    });
    expect(violations).toEqual([]);
  });

  test("append + load round-trips per contact", async () => {
    const mem = fakeMemory();
    await mem.append({ id: "t1", contactId: "c1", role: "user", timestamp: 0 });
    await mem.append({ id: "t2", contactId: "c2", role: "user", timestamp: 0 });
    expect((await mem.load("c1")).map((t) => t.id)).toEqual(["t1"]);
    expect((await mem.load("c2")).map((t) => t.id)).toEqual(["t2"]);
  });

  test("a broken memory (load() not an array) fails conformance", async () => {
    const broken: Memory = {
      // @ts-expect-error deliberately invalid
      load: async () => "nope",
      append: async () => {},
      recall: async () => [],
    };
    const violations = await runMemoryConformance(broken, { contactId: "c1", turn: { id: "t1", contactId: "c1", role: "user", timestamp: 0 } });
    expect(violations.some((v) => v.includes("load() must return an array"))).toBe(true);
  });

  test("a fixture with mismatched contactId is reported, not silently run", async () => {
    const violations = await runMemoryConformance(fakeMemory(), {
      contactId: "c1",
      turn: { id: "t1", contactId: "c2", role: "user", timestamp: 0 },
    });
    expect(violations).toEqual(["fixture: turn.contactId must equal fixture contactId"]);
  });

  test("a broken memory (recall() not string[]) fails conformance", async () => {
    const broken: Memory = {
      load: async () => [],
      append: async () => {},
      // @ts-expect-error deliberately invalid
      recall: async () => [1, 2, 3],
    };
    const violations = await runMemoryConformance(broken, { contactId: "c1", turn: { id: "t1", contactId: "c1", role: "user", timestamp: 0 } });
    expect(violations).toContain("recall() must return string[]");
  });

  test("a broken memory (load() contains a malformed Turn) fails conformance", async () => {
    const broken: Memory = {
      // @ts-expect-error deliberately invalid: missing required fields
      load: async () => [{ id: "t1" }],
      append: async () => {},
      recall: async () => [],
    };
    const violations = await runMemoryConformance(broken, { contactId: "c1", turn: { id: "t1", contactId: "c1", role: "user", timestamp: 0 } });
    expect(violations.join("\n")).toMatch(/not a valid Turn/);
  });
});

describe("fakeRouter", () => {
  const input = { message: { id: "m1", contactId: "c1", channel: "whatsapp", timestamp: 0 }, history: [], availableSkills: [], availableTools: [] };

  test("passes router conformance", async () => {
    const violations = await runRouterConformance(fakeRouter(), { input });
    expect(violations).toEqual([]);
  });

  test("scripted decisions play back in order, then repeat the last one", async () => {
    const r = fakeRouter([
      { intent: "a", needsRAG: false, needsTool: false, escalate: false, confidence: 0.1 },
      { intent: "b", needsRAG: false, needsTool: false, escalate: false, confidence: 0.9 },
    ]);
    expect((await r.route(input)).intent).toBe("a");
    expect((await r.route(input)).intent).toBe("b");
    expect((await r.route(input)).intent).toBe("b");
    expect(r.calls).toHaveLength(3);
  });

  test("decisions as a function of the input", async () => {
    const r = fakeRouter((i) => ({ intent: i.message.text ?? "empty", needsRAG: false, needsTool: false, escalate: false, confidence: 1 }));
    expect((await r.route({ ...input, message: { ...input.message, text: "hours?" } })).intent).toBe("hours?");
  });

  test("a broken router (confidence out of range) fails conformance", async () => {
    const broken: Router = {
      // @ts-expect-error deliberately invalid
      route: async () => ({ intent: "x", needsRAG: false, needsTool: false, escalate: false, confidence: 2 }),
    };
    const violations = await runRouterConformance(broken, { input });
    expect(violations.join("\n")).toMatch(/not a valid RouterDecision/);
  });
});

describe("fakeToolProvider", () => {
  test("passes tool provider conformance", async () => {
    const provider = fakeToolProvider("orders", [{ name: "getOrder", result: { toolName: "getOrder", ok: true, data: { id: 8842 } } }]);
    const violations = await runToolProviderConformance(provider, { args: { id: 8842 } });
    expect(violations).toEqual([]);
  });

  test("records execute() calls", async () => {
    const provider = fakeToolProvider("orders", [{ name: "getOrder" }]);
    const tools = await provider.listTools();
    await tools[0]!.execute({ id: 1 });
    expect(provider.calls).toEqual([{ name: "getOrder", args: { id: 1 } }]);
  });

  test("result can be a function of the call args", async () => {
    const provider = fakeToolProvider("orders", [{ name: "getOrder", result: (args) => ({ toolName: "getOrder", ok: true, data: args }) }]);
    const tools = await provider.listTools();
    expect(await tools[0]!.execute({ id: 42 })).toEqual({ toolName: "getOrder", ok: true, data: { id: 42 } });
  });

  test("a broken provider (duplicate tool names) fails conformance", async () => {
    const dupe = { name: "getOrder", description: "d", parameters: {}, readOnly: true, confirmBefore: false, execute: async () => ({ toolName: "getOrder", ok: true }) };
    const broken: ToolProvider = { name: "orders", listTools: () => [dupe, dupe] };
    const violations = await runToolProviderConformance(broken);
    expect(violations.some((v) => v.includes("duplicate tool name"))).toBe(true);
  });

  test("a provider with an empty name fails conformance", async () => {
    const violations = await runToolProviderConformance({ name: "", listTools: () => [] });
    expect(violations).toContain("ToolProvider.name must be a non-empty string");
  });

  test("a provider whose listTools() isn't an array fails conformance", async () => {
    // @ts-expect-error deliberately invalid
    const violations = await runToolProviderConformance({ name: "orders", listTools: () => "nope" });
    expect(violations).toEqual(["listTools() must return an array"]);
  });

  test("a tool missing every required field is fully reported", async () => {
    const bad = { name: "", description: "", parameters: null, readOnly: "yes", confirmBefore: "no", execute: async () => ({ toolName: "x", ok: false, error: "bad" }) };
    // @ts-expect-error deliberately invalid
    const broken: ToolProvider = { name: "orders", listTools: () => [bad] };
    const violations = await runToolProviderConformance(broken);
    expect(violations).toEqual(
      expect.arrayContaining([
        "tools[0] missing name",
        "tools[0] () missing description",
        "tools[0] () parameters must be a JSON Schema object",
        "tools[0] () readOnly must be boolean",
        "tools[0] () confirmBefore must be boolean",
      ]),
    );
  });

  test("a tool whose execute() returns an invalid ToolResult fails conformance", async () => {
    const bad = { name: "getOrder", description: "d", parameters: {}, readOnly: true, confirmBefore: false, execute: async () => ({ ok: true }) };
    // @ts-expect-error deliberately invalid: missing required toolName
    const broken: ToolProvider = { name: "orders", listTools: () => [bad] };
    const violations = await runToolProviderConformance(broken);
    expect(violations.join("\n")).toMatch(/not a valid ToolResult/);
  });
});
