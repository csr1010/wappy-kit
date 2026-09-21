import { describe, expect, test } from "vitest";
import { createClient } from "@libsql/client";
import type { Clock } from "@wappy/core";
import { cancelSelectionId, confirmSelectionId, createConfirmFlow, parseConfirmSelection } from "./confirm.js";

function fakeClock(startAt = 1_000_000): Clock & { advance(ms: number): void } {
  let now = startAt;
  return {
    now: () => now,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    sleep: async () => undefined,
    advance(ms) {
      now += ms;
    },
  };
}

describe("createConfirmFlow", () => {
  test("no pending confirmation for a fresh contact", async () => {
    const flow = createConfirmFlow({ client: createClient({ url: ":memory:" }), clock: fakeClock() });
    expect(await flow.getPending("c1")).toBeUndefined();
  });

  test("request() then getPending() round-trips the pending confirmation", async () => {
    const flow = createConfirmFlow({ client: createClient({ url: ":memory:" }), clock: fakeClock() });
    const pending = await flow.request({ contactId: "c1", toolName: "cancelOrder", args: { id: "1001" }, summary: "cancelOrder with 1001" });
    const found = await flow.getPending("c1");
    expect(found).toEqual(pending);
    expect(found?.toolName).toBe("cancelOrder");
    expect(found?.args).toEqual({ id: "1001" });
  });

  test("resolve() removes the pending confirmation", async () => {
    const flow = createConfirmFlow({ client: createClient({ url: ":memory:" }), clock: fakeClock() });
    await flow.request({ contactId: "c1", toolName: "x", args: {}, summary: "x" });
    await flow.resolve("c1");
    expect(await flow.getPending("c1")).toBeUndefined();
  });

  test("resolve() on an already-resolved (or never-requested) contact is a harmless no-op", async () => {
    const flow = createConfirmFlow({ client: createClient({ url: ":memory:" }), clock: fakeClock() });
    await expect(flow.resolve("nobody")).resolves.toBeUndefined();
  });

  test("a pending confirmation expires after its TTL — getPending() returns undefined, never auto-fires", async () => {
    const clock = fakeClock();
    const flow = createConfirmFlow({ client: createClient({ url: ":memory:" }), clock, ttlMs: 1000 });
    await flow.request({ contactId: "c1", toolName: "x", args: {}, summary: "x" });
    expect(await flow.getPending("c1")).toBeDefined();
    clock.advance(1001);
    expect(await flow.getPending("c1")).toBeUndefined();
  });

  test("a new request() for the same contact replaces (not accumulates alongside) an earlier unresolved one", async () => {
    const flow = createConfirmFlow({ client: createClient({ url: ":memory:" }), clock: fakeClock() });
    await flow.request({ contactId: "c1", toolName: "first", args: {}, summary: "first" });
    await flow.request({ contactId: "c1", toolName: "second", args: {}, summary: "second" });
    const pending = await flow.getPending("c1");
    expect(pending?.toolName).toBe("second");
  });

  test("pending confirmations are scoped per contact", async () => {
    const flow = createConfirmFlow({ client: createClient({ url: ":memory:" }), clock: fakeClock() });
    await flow.request({ contactId: "c1", toolName: "x", args: {}, summary: "x" });
    expect(await flow.getPending("c2")).toBeUndefined();
  });

  test("confirmSelectionId()/cancelSelectionId() embed the pending confirmation's own id, and parseConfirmSelection() round-trips it", () => {
    expect(confirmSelectionId("abc123")).toBe("confirm:abc123");
    expect(cancelSelectionId("abc123")).toBe("cancel:abc123");
    expect(parseConfirmSelection(confirmSelectionId("abc123"))).toEqual({ action: "confirm", pendingId: "abc123" });
    expect(parseConfirmSelection(cancelSelectionId("abc123"))).toEqual({ action: "cancel", pendingId: "abc123" });
  });

  test("parseConfirmSelection() returns undefined for anything that isn't a well-formed confirm/cancel selection", () => {
    expect(parseConfirmSelection(undefined)).toBeUndefined();
    expect(parseConfirmSelection("")).toBeUndefined();
    expect(parseConfirmSelection("confirm")).toBeUndefined(); // legacy bare constant, no embedded id — deliberately rejected
    expect(parseConfirmSelection("cancel")).toBeUndefined();
    expect(parseConfirmSelection("confirm:")).toBeUndefined(); // empty id
    expect(parseConfirmSelection("track_order")).toBeUndefined(); // an unrelated button from some other skill
    expect(parseConfirmSelection("delete:abc123")).toBeUndefined(); // not a recognized action
  });

  test("a transient failure creating the schema is retried on the next call, not permanently cached", async () => {
    const client = createClient({ url: ":memory:" });
    const originalExecuteMultiple = client.executeMultiple.bind(client);
    let executeMultipleCalls = 0;
    client.executeMultiple = (sql: string) => {
      executeMultipleCalls++;
      if (executeMultipleCalls === 1) return Promise.reject(new Error("transient connection blip"));
      return originalExecuteMultiple(sql);
    };
    const flow = createConfirmFlow({ client, clock: fakeClock() });

    await expect(flow.getPending("c1")).rejects.toThrow("transient connection blip");
    expect(await flow.getPending("c1")).toBeUndefined();
    expect(executeMultipleCalls).toBe(2);
  });
});
