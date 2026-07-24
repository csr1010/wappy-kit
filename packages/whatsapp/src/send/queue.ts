import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { CloudApiOutboundPayload } from "./render.js";

export type QueueItemStatus = "pending" | "sent" | "failed";

export interface QueueItem {
  idempotencyKey: string;
  to: string;
  payload: CloudApiOutboundPayload;
  status: QueueItemStatus;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  metaMessageId?: string;
  lastError?: string;
}

/**
 * Persistent outbound queue (§10 "idempotency key so a retry after crash never double-sends").
 * Honest limit: Meta's /messages endpoint has no client-supplied idempotency key of its own, so
 * this can't guarantee Meta-side exactly-once delivery for a crash mid-HTTP-call (we genuinely
 * don't know if they received it). What it DOES guarantee: OUR process re-queuing the same
 * logical send (e.g. re-handling the same inbound message after a restart) never creates a SECOND
 * queue entry — enqueue() is idempotent by key, and a `sent` item is never re-attempted.
 */
export interface OutboundQueue {
  /** No-op (returns the existing item) if idempotencyKey is already queued — crash-safe re-submission. */
  enqueue(item: { idempotencyKey: string; to: string; payload: CloudApiOutboundPayload }, now: number): QueueItem;
  update(idempotencyKey: string, patch: Partial<Pick<QueueItem, "status" | "attempts" | "metaMessageId" | "lastError">>, now: number): void;
  get(idempotencyKey: string): QueueItem | undefined;
  pending(): QueueItem[];
}

function loadQueueFile(path: string): QueueItem[] {
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(raw?.items) ? raw.items : [];
  } catch {
    return []; // a corrupt queue file starts fresh rather than crashing the process — outbound sends are re-derived from the agent, not the sole record of truth
  }
}

function saveQueueFile(path: string, items: QueueItem[]): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify({ items }, null, 2));
  renameSync(tmp, path);
}

export function createFileOutboundQueue(path: string): OutboundQueue {
  let items = loadQueueFile(path);

  return {
    enqueue(item, now) {
      const existing = items.find((i) => i.idempotencyKey === item.idempotencyKey);
      if (existing) return existing;
      const record: QueueItem = { ...item, status: "pending", attempts: 0, createdAt: now, updatedAt: now };
      items = [...items, record];
      saveQueueFile(path, items);
      return record;
    },

    update(idempotencyKey, patch, now) {
      items = items.map((i) => (i.idempotencyKey === idempotencyKey ? { ...i, ...patch, updatedAt: now } : i));
      saveQueueFile(path, items);
    },

    get: (idempotencyKey) => items.find((i) => i.idempotencyKey === idempotencyKey),
    pending: () => items.filter((i) => i.status === "pending"),
  };
}

/** In-memory queue (same contract, no disk) — for callers/tests that don't need persistence. */
export function createMemoryOutboundQueue(): OutboundQueue {
  const items: QueueItem[] = [];
  return {
    enqueue(item, now) {
      const existing = items.find((i) => i.idempotencyKey === item.idempotencyKey);
      if (existing) return existing;
      const record: QueueItem = { ...item, status: "pending", attempts: 0, createdAt: now, updatedAt: now };
      items.push(record);
      return record;
    },
    update(idempotencyKey, patch, now) {
      const i = items.findIndex((x) => x.idempotencyKey === idempotencyKey);
      if (i !== -1) items[i] = { ...items[i]!, ...patch, updatedAt: now };
    },
    get: (idempotencyKey) => items.find((i) => i.idempotencyKey === idempotencyKey),
    pending: () => items.filter((i) => i.status === "pending"),
  };
}
