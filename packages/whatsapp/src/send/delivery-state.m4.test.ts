import { describe, expect, test } from "vitest";
import { applyStatusEvent, type DeliveryRecord } from "./delivery-state.js";

const record: DeliveryRecord = { idempotencyKey: "k1", contactId: "c1", state: "sending", attempts: 1, metaMessageId: "wamid.out1", updatedAt: 0 };

describe("applyStatusEvent", () => {
  test.each(["sent", "delivered", "read"] as const)("advances state to %s", (status) => {
    const next = applyStatusEvent(record, { messageId: "wamid.out1", status, timestamp: 5, recipientId: "c1" }, 10);
    expect(next.state).toBe(status);
    expect(next.updatedAt).toBe(10);
  });

  test("a failed status carries the error message", () => {
    const next = applyStatusEvent(record, { messageId: "wamid.out1", status: "failed", timestamp: 5, recipientId: "c1", error: { code: 131026, message: "undeliverable" } }, 10);
    expect(next.state).toBe("failed");
    expect(next.lastError).toBe("131026: undeliverable");
  });

  test("a status for a different metaMessageId is ignored", () => {
    const next = applyStatusEvent(record, { messageId: "wamid.someone-else", status: "read", timestamp: 5, recipientId: "c1" }, 10);
    expect(next).toEqual(record);
  });

  test("a failed status with no error object leaves lastError as it was", () => {
    const next = applyStatusEvent(record, { messageId: "wamid.out1", status: "failed", timestamp: 5, recipientId: "c1" }, 10);
    expect(next.lastError).toBeUndefined();
  });

  describe("monotonic ordering (out-of-order / redelivered webhooks)", () => {
    const read: DeliveryRecord = { ...record, state: "read", updatedAt: 5 };

    test("a late 'delivered' arriving after 'read' is ignored, not a regression", () => {
      const next = applyStatusEvent(read, { messageId: "wamid.out1", status: "delivered", timestamp: 20, recipientId: "c1" }, 20);
      expect(next).toEqual(read);
    });

    test("a stale 'failed' arriving after 'delivered' is ignored", () => {
      const delivered: DeliveryRecord = { ...record, state: "delivered", updatedAt: 5 };
      const next = applyStatusEvent(delivered, { messageId: "wamid.out1", status: "failed", timestamp: 20, recipientId: "c1", error: { code: 1, message: "x" } }, 20);
      expect(next).toEqual(delivered);
    });

    test("a genuine 'failed' before any delivery confirmation IS applied", () => {
      const sent: DeliveryRecord = { ...record, state: "sent", updatedAt: 5 };
      const next = applyStatusEvent(sent, { messageId: "wamid.out1", status: "failed", timestamp: 20, recipientId: "c1", error: { code: 1, message: "x" } }, 20);
      expect(next.state).toBe("failed");
    });

    test("once failed, nothing (including a later delivered/read/failed) changes the record further", () => {
      const failed: DeliveryRecord = { ...record, state: "failed", lastError: "1: x", updatedAt: 5 };
      for (const status of ["sent", "delivered", "read", "failed"] as const) {
        expect(applyStatusEvent(failed, { messageId: "wamid.out1", status, timestamp: 20, recipientId: "c1" }, 20)).toEqual(failed);
      }
    });

    test("a repeated identical status (duplicate webhook) is a no-op, not re-applied", () => {
      const next = applyStatusEvent(read, { messageId: "wamid.out1", status: "read", timestamp: 20, recipientId: "c1" }, 20);
      expect(next).toEqual(read); // updatedAt unchanged — the repeat was ignored, not reprocessed
    });

    test("forward progress (sent -> delivered -> read in order) is always applied", () => {
      let r: DeliveryRecord = { ...record, state: "sending", updatedAt: 0 };
      r = applyStatusEvent(r, { messageId: "wamid.out1", status: "sent", timestamp: 1, recipientId: "c1" }, 1);
      r = applyStatusEvent(r, { messageId: "wamid.out1", status: "delivered", timestamp: 2, recipientId: "c1" }, 2);
      r = applyStatusEvent(r, { messageId: "wamid.out1", status: "read", timestamp: 3, recipientId: "c1" }, 3);
      expect(r.state).toBe("read");
      expect(r.updatedAt).toBe(3);
    });
  });
});
