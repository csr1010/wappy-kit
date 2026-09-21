import { describe, expect, test } from "vitest";
import { createClient } from "@libsql/client";
import type { Clock } from "@wappy/core";
import { CANCEL_SELECTION_ID, CONFIRM_SELECTION_ID, createConfirmFlow } from "./confirm.js";

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

  test("exports the reserved confirm/cancel selectionId constants", () => {
    expect(CONFIRM_SELECTION_ID).toBe("confirm");
    expect(CANCEL_SELECTION_ID).toBe("cancel");
  });
});
