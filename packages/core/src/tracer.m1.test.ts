import { describe, expect, test } from "vitest";
import { createInMemoryTracer } from "./tracer.js";

describe("createInMemoryTracer", () => {
  test("touched() accumulates the set of systems recorded", () => {
    const t = createInMemoryTracer();
    t.record("whatsapp", "inbound");
    t.record("memory", "load");
    t.record("whatsapp", "sent");
    expect(t.touched()).toEqual(new Set(["whatsapp", "memory"]));
  });

  test("scenario A (hi): touches exactly whatsapp, memory, router, llm", () => {
    const t = createInMemoryTracer();
    t.record("whatsapp", "receive");
    t.record("memory", "load");
    t.record("router", "route");
    t.record("llm", "generate");
    t.record("whatsapp", "send");
    t.record("memory", "append");
    expect(t.touched()).toEqual(new Set(["whatsapp", "memory", "router", "llm"]));
    expect(t.touched().has("rag")).toBe(false);
    expect(t.touched().has("tools")).toBe(false);
  });

  test("events() preserves order and payload", () => {
    let t0 = 100;
    const clock = { now: () => t0++ };
    const t = createInMemoryTracer(clock);
    t.record("router", "route", { intent: "greeting" });
    t.record("llm", "generate");
    expect(t.events()).toEqual([
      { system: "router", event: "route", data: { intent: "greeting" }, at: 100 },
      { system: "llm", event: "generate", data: undefined, at: 101 },
    ]);
  });

  test("touched() returns a snapshot copy, not a live reference", () => {
    const t = createInMemoryTracer();
    const snap = t.touched();
    t.record("tools", "call");
    expect(snap.has("tools")).toBe(false);
    expect(t.touched().has("tools")).toBe(true);
  });
});
