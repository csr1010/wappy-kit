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
});
