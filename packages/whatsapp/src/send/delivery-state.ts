import type { StatusEvent } from "../parser.js";

export type DeliveryState = "queued" | "sending" | "sent" | "delivered" | "read" | "failed";

export interface DeliveryRecord {
  idempotencyKey: string;
  contactId: string;
  state: DeliveryState;
  attempts: number;
  lastError?: string;
  metaMessageId?: string;
  updatedAt: number;
}

/** Advances a DeliveryRecord's state from an incoming status webhook (§6.2 "sent→delivered→read | failed"). */
export function applyStatusEvent(record: DeliveryRecord, status: StatusEvent, now: number): DeliveryRecord {
  if (status.messageId !== record.metaMessageId) return record; // not about this send

  const lastError = status.status === "failed" && status.error ? `${status.error.code}: ${status.error.message}` : record.lastError;
  return { ...record, state: status.status, lastError, updatedAt: now };
}
