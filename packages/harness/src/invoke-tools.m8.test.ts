import { describe, expect, test } from "vitest";
import { createClient } from "@libsql/client";
import { systemClock } from "@wappy/core";
import type { InboundMessage, Model, RouterDecision, Tool, ToolResult } from "@wappy/core";
import { createToolInvoker } from "./invoke-tools.js";
import { createConfirmFlow } from "./confirm.js";

function message(text: string): InboundMessage {
  return { id: "m1", contactId: "c1", channel: "whatsapp", text, timestamp: 0 } as InboundMessage;
}

const DECISION: RouterDecision = { intent: "order-status", needsRAG: false, needsTool: true, escalate: false, confidence: 0.9 };

function tool(name: string, execute: (args: unknown) => Promise<ToolResult>): Tool {
  return { name, description: `${name} tool`, parameters: { type: "object", properties: {} }, readOnly: true, confirmBefore: false, execute };
}

function writeTool(name: string, execute: (args: unknown) => Promise<ToolResult>): Tool {
  return { name, description: `${name} tool`, parameters: { type: "object", properties: {} }, readOnly: false, confirmBefore: true, execute };
}

function decisionModel(response: { toolName?: string; args?: unknown } | undefined): Model {
  return { generate: async () => ({ structured: response }) };
}

describe("createToolInvoker", () => {
  test("a textless message (e.g. media-only) falls back to an empty query — no lexical relevance, no findings, model never called", async () => {
    let called = false;
    const model: Model = { generate: async () => { called = true; return { structured: {} }; } };
    const getOrder = tool("getOrder", async () => ({ toolName: "getOrder", ok: true, data: {} }));
    const invoke = createToolInvoker({ model, tools: [getOrder] });
    const textlessMessage: InboundMessage = { id: "m1", contactId: "c1", channel: "whatsapp", timestamp: 0 };
    const findings = await invoke({ message: textlessMessage, decision: DECISION });
    expect(findings).toEqual([]);
    expect(called).toBe(false); // an empty query has zero lexical relevance to any tool — selectTools returns none
  });

  test("no candidate tools at all (empty pool) never calls the model", async () => {
    let called = false;
    const model: Model = { generate: async () => { called = true; return { structured: {} }; } };
    const invoke = createToolInvoker({ model, tools: [] });
    const findings = await invoke({ message: message("where's my order 8842?"), decision: DECISION });
    expect(findings).toEqual([]);
    expect(called).toBe(false);
  });

  test("model decides no tool applies (omits toolName) -> no findings, tool never called", async () => {
    let executeCalled = false;
    const getOrder = tool("getOrder", async () => { executeCalled = true; return { toolName: "getOrder", ok: true, data: {} }; });
    const invoke = createToolInvoker({ model: decisionModel({}), tools: [getOrder] });
    const findings = await invoke({ message: message("where's my order 8842?"), decision: DECISION });
    expect(findings).toEqual([]);
    expect(executeCalled).toBe(false);
  });

  test("model decides a tool + args -> that tool's real execute() is called exactly once with those args", async () => {
    let calls = 0;
    let seenArgs: unknown;
    const getOrder = tool("getOrder", async (args) => {
      calls++;
      seenArgs = args;
      return { toolName: "getOrder", ok: true, data: { id: "8842", status: "shipped" } };
    });
    const invoke = createToolInvoker({ model: decisionModel({ toolName: "getOrder", args: { id: "8842" } }), tools: [getOrder] });
    const findings = await invoke({ message: message("where's my order 8842?"), decision: DECISION });
    expect(calls).toBe(1);
    expect(seenArgs).toEqual({ id: "8842" });
    expect(findings.length).toBe(1);
    expect(findings[0]).toContain("8842");
    expect(findings[0]).toContain("shipped");
  });

  test("a decided toolName outside the offered candidate set is ignored, not guessed at", async () => {
    let executeCalled = false;
    const getOrder = tool("getOrder", async () => { executeCalled = true; return { toolName: "getOrder", ok: true, data: {} }; });
    const invoke = createToolInvoker({ model: decisionModel({ toolName: "deleteEverything", args: {} }), tools: [getOrder] });
    const findings = await invoke({ message: message("where's my order?"), decision: DECISION });
    expect(findings).toEqual([]);
    expect(executeCalled).toBe(false);
  });

  test("a tool result is bounded (T6.6, boundToolResult finally wired) before becoming a finding", async () => {
    const bigArray = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    const listOrders = tool("listOrders", async () => ({ toolName: "listOrders", ok: true, data: bigArray }));
    const invoke = createToolInvoker({ model: decisionModel({ toolName: "listOrders" }), tools: [listOrders], boundOptions: { maxBytes: 500, maxArrayItems: 3 } });
    const findings = await invoke({ message: message("list my orders"), decision: DECISION });
    expect(findings.length).toBe(1);
    const parsed = JSON.parse(findings[0]!.replace(/ \(showing.*\)$/, "")) as unknown[];
    expect(parsed.length).toBeLessThanOrEqual(3);
    expect(findings[0]).toContain("showing");
  });

  test("a tool result that's already a plain string is used verbatim, not re-JSON-stringified", async () => {
    const echoTool = tool("echo", async () => ({ toolName: "echo", ok: true, data: "order 8842 shipped yesterday" }));
    const invoke = createToolInvoker({ model: decisionModel({ toolName: "echo" }), tools: [echoTool] });
    const findings = await invoke({ message: message("echo my status"), decision: DECISION });
    expect(findings).toEqual(["order 8842 shipped yesterday"]);
  });

  describe("tool-failure path (T8.6)", () => {
    test("a tool resolving ok:false produces an honest failure finding and fires onToolFailure", async () => {
      let notified: { toolName: string; error: string } | undefined;
      const flaky = tool("getOrder", async () => ({ toolName: "getOrder", ok: false, error: "upstream API returned 503" }));
      const invoke = createToolInvoker({ model: decisionModel({ toolName: "getOrder", args: { id: "1" } }), tools: [flaky], onToolFailure: (info) => { notified = info; } });
      const findings = await invoke({ message: message("where's my order?"), decision: DECISION });
      expect(findings.length).toBe(1);
      expect(findings[0]).toContain("getOrder");
      expect(findings[0]).toContain("503");
      expect(findings[0]).toMatch(/honestly|couldn't|team will follow up/i);
      expect(findings[0]).not.toContain('"ok":true');
      expect(notified).toEqual({ toolName: "getOrder", error: "upstream API returned 503" });
    });

    test("a tool resolving ok:false with no `error` field falls back to 'unknown error'", async () => {
      const flaky = tool("getOrder", async () => ({ toolName: "getOrder", ok: false }));
      const invoke = createToolInvoker({ model: decisionModel({ toolName: "getOrder", args: {} }), tools: [flaky] });
      const findings = await invoke({ message: message("where's my order?"), decision: DECISION });
      expect(findings[0]).toContain("unknown error");
    });

    test("a tool that throws a non-Error value (e.g. a plain string) is still caught and stringified", async () => {
      const broken = tool("getOrder", async () => { throw "a plain string rejection"; });
      const invoke = createToolInvoker({ model: decisionModel({ toolName: "getOrder", args: {} }), tools: [broken] });
      const findings = await invoke({ message: message("where's my order?"), decision: DECISION });
      expect(findings[0]).toContain("a plain string rejection");
    });

    test("a tool that THROWS is caught, produces an honest finding, and still fires onToolFailure", async () => {
      let notified: { toolName: string; error: string } | undefined;
      const broken = tool("getOrder", async () => { throw new Error("connection refused"); });
      const invoke = createToolInvoker({ model: decisionModel({ toolName: "getOrder", args: { id: "1" } }), tools: [broken], onToolFailure: (info) => { notified = info; } });
      const findings = await invoke({ message: message("where's my order?"), decision: DECISION });
      expect(findings.length).toBe(1);
      expect(findings[0]).toContain("connection refused");
      expect(notified?.error).toBe("connection refused");
    });

    test("onToolFailure itself throwing doesn't propagate or replace the failure finding", async () => {
      const flaky = tool("getOrder", async () => ({ toolName: "getOrder", ok: false, error: "down" }));
      const invoke = createToolInvoker({
        model: decisionModel({ toolName: "getOrder", args: {} }),
        tools: [flaky],
        onToolFailure: () => { throw new Error("webhook unreachable"); },
      });
      const findings = await invoke({ message: message("where's my order?"), decision: DECISION });
      expect(findings.length).toBe(1);
      expect(findings[0]).toContain("down");
    });

    test("no onToolFailure configured: a failure still degrades to an honest finding", async () => {
      const flaky = tool("getOrder", async () => ({ toolName: "getOrder", ok: false, error: "timeout" }));
      const invoke = createToolInvoker({ model: decisionModel({ toolName: "getOrder", args: {} }), tools: [flaky] });
      const findings = await invoke({ message: message("where's my order?"), decision: DECISION });
      expect(findings[0]).toContain("timeout");
    });
  });

  describe("confirmBefore tools (T8.5 request side)", () => {
    function flow() {
      return createConfirmFlow({ client: createClient({ url: ":memory:" }), clock: systemClock });
    }

    test("a confirmBefore tool is never executed directly — it's held pending instead", async () => {
      let executed = false;
      const cancelOrder = writeTool("cancelOrder", async () => { executed = true; return { toolName: "cancelOrder", ok: true, data: {} }; });
      const confirmFlow = flow();
      const invoke = createToolInvoker({ model: decisionModel({ toolName: "cancelOrder", args: { id: "1001" } }), tools: [cancelOrder], confirmFlow });
      const findings = await invoke({ message: message("cancel my order 1001"), decision: DECISION });
      expect(executed).toBe(false);
      expect(findings.length).toBe(1);
      expect(findings[0]).toContain("confirm");
      expect(findings[0]).toContain("cancel");
      expect(findings[0]).toContain("NOT been executed yet");
      expect(findings[0]).not.toMatch(/^Done —/);
    });

    test("requesting confirmation persists a pending confirmation for the message's contact", async () => {
      const cancelOrder = writeTool("cancelOrder", async () => ({ toolName: "cancelOrder", ok: true, data: {} }));
      const confirmFlow = flow();
      const invoke = createToolInvoker({ model: decisionModel({ toolName: "cancelOrder", args: { id: "1001" } }), tools: [cancelOrder], confirmFlow });
      await invoke({ message: message("cancel my order 1001"), decision: DECISION });
      const pending = await confirmFlow.getPending("c1");
      expect(pending?.toolName).toBe("cancelOrder");
      expect(pending?.args).toEqual({ id: "1001" });
    });

    test("without a confirmFlow configured, a confirmBefore tool is refused, not silently executed", async () => {
      let executed = false;
      const cancelOrder = writeTool("cancelOrder", async () => { executed = true; return { toolName: "cancelOrder", ok: true, data: {} }; });
      const invoke = createToolInvoker({ model: decisionModel({ toolName: "cancelOrder", args: {} }), tools: [cancelOrder] });
      const findings = await invoke({ message: message("cancel my order"), decision: DECISION });
      expect(executed).toBe(false);
      expect(findings[0]).toMatch(/no confirmation flow|not.*configured/i);
    });

    test("a confirmBefore decision with no args still persists a pending confirmation (defaults to {})", async () => {
      const cancelOrder = writeTool("cancelOrder", async () => ({ toolName: "cancelOrder", ok: true, data: {} }));
      const confirmFlow = flow();
      const invoke = createToolInvoker({ model: decisionModel({ toolName: "cancelOrder" }), tools: [cancelOrder], confirmFlow });
      await invoke({ message: message("cancel my order"), decision: DECISION });
      const pending = await confirmFlow.getPending("c1");
      expect(pending?.args).toEqual({});
    });

    test("a read-only (confirmBefore: false) tool is unaffected by a configured confirmFlow — executes immediately as usual", async () => {
      let executed = false;
      const getOrder = tool("getOrder", async () => { executed = true; return { toolName: "getOrder", ok: true, data: { status: "shipped" } }; });
      const confirmFlow = flow();
      const invoke = createToolInvoker({ model: decisionModel({ toolName: "getOrder", args: {} }), tools: [getOrder], confirmFlow });
      await invoke({ message: message("where's my order"), decision: DECISION });
      expect(executed).toBe(true);
      expect(await confirmFlow.getPending("c1")).toBeUndefined();
    });
  });

  test("the decision call's prompt carries the actual message text, not a stale/raw one", async () => {
    let seenPrompt = "";
    const model: Model = { generate: async (req) => { seenPrompt = req.prompt; return { structured: {} }; } };
    const getOrder = tool("getOrder", async () => ({ toolName: "getOrder", ok: true, data: {} }));
    const invoke = createToolInvoker({ model, tools: [getOrder] });
    await invoke({ message: message("where's my order 8842?"), decision: DECISION });
    expect(seenPrompt).toContain("8842");
  });
});
