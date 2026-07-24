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

// Progress rank for the non-terminal states. "failed" isn't part of the ladder — see below.
const PROGRESS_RANK: Record<"queued" | "sending" | "sent" | "delivered" | "read", number> = { queued: 0, sending: 1, sent: 2, delivered: 3, read: 4 };

/**
 * Advances a DeliveryRecord's state from an incoming status webhook (§6.2 "sent→delivered→read |
 * failed"). Status webhooks are not guaranteed to arrive in order and can be redelivered (the same
 * reason the outbound queue needs idempotency keys), so this is monotonic:
 *  - "failed" is terminal, and once reached nothing changes the record further.
 *  - "read" is the top of the progress ladder, so nothing (except it never regresses) beats it either.
 *  - a "failed" webhook is only meaningful before delivery is confirmed — once `delivered`/`read`
 *    has arrived, a later "failed" is a stale duplicate of an earlier attempt and is ignored.
 *  - any other out-of-order or exactly-repeated status (rank <= the record's current rank) is ignored.
 */
export function applyStatusEvent(record: DeliveryRecord, status: StatusEvent, now: number): DeliveryRecord {
  if (status.messageId !== record.metaMessageId) return record; // not about this send
  if (record.state === "failed") return record; // terminal

  const currentRank = PROGRESS_RANK[record.state];
  if (status.status === "failed") {
    if (currentRank >= PROGRESS_RANK.delivered) return record; // already confirmed delivered/read — stale
  } else if (PROGRESS_RANK[status.status] <= currentRank) {
    return record; // regression or an exact repeat — no forward progress
  }

  const lastError = status.status === "failed" && status.error ? `${status.error.code}: ${status.error.message}` : record.lastError;
  return { ...record, state: status.status, lastError, updatedAt: now };
}
