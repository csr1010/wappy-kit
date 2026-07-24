import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
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
 * Async throughout — this sits on channel.send()'s hot path, so it must never block the event loop
 * with synchronous disk I/O. Every read-modify-write is serialized through one promise chain per
 * queue instance (see `serialize` below) so concurrent enqueue()/update() calls can't race and
 * silently drop each other's writes.
 *
 * Honest limit: Meta's /messages endpoint has no client-supplied idempotency key of its own, so
 * this can't guarantee Meta-side exactly-once delivery for a crash mid-HTTP-call (we genuinely
 * don't know if they received it). What it DOES guarantee: OUR process re-queuing the same
 * logical send (e.g. re-handling the same inbound message after a restart) never creates a SECOND
 * queue entry — enqueue() is idempotent by key, and a `sent` item is never re-attempted.
 */
export interface OutboundQueue {
  /** No-op (returns the existing item) if idempotencyKey is already queued — crash-safe re-submission. */
  enqueue(item: { idempotencyKey: string; to: string; payload: CloudApiOutboundPayload }, now: number): Promise<QueueItem>;
  update(idempotencyKey: string, patch: Partial<Pick<QueueItem, "status" | "attempts" | "metaMessageId" | "lastError">>, now: number): Promise<void>;
  get(idempotencyKey: string): Promise<QueueItem | undefined>;
  pending(): Promise<QueueItem[]>;
}

async function loadQueueFile(path: string): Promise<QueueItem[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch {
    // No file yet (ENOENT) or a corrupt one (bad JSON) — both start fresh rather than crashing the
    // process; outbound sends are re-derived from the agent, not the sole record of truth.
    return [];
  }
  return Array.isArray((raw as { items?: unknown } | null)?.items) ? ((raw as { items: QueueItem[] }).items) : [];
}

async function saveQueueFile(path: string, items: QueueItem[]): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, JSON.stringify({ items }, null, 2));
  try {
    await rename(tmp, path);
  } catch (e) {
    try {
      await unlink(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw e;
  }
}

export function createFileOutboundQueue(path: string): OutboundQueue {
  let items: QueueItem[] | undefined;
  // Every mutation (and the lazy initial load) chains off this promise, so concurrent callers
  // never interleave their read-modify-write and clobber each other's writes.
  let chain: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = chain.then(fn);
    chain = result.catch(() => {}); // one failed op must not wedge the chain for everyone after it
    return result;
  };
  const ensureLoaded = async (): Promise<QueueItem[]> => (items ??= await loadQueueFile(path));

  return {
    enqueue: (item, now) =>
      serialize(async () => {
        const current = await ensureLoaded();
        const existing = current.find((i) => i.idempotencyKey === item.idempotencyKey);
        if (existing) return existing;
        const record: QueueItem = { ...item, status: "pending", attempts: 0, createdAt: now, updatedAt: now };
        const next = [...current, record];
        await saveQueueFile(path, next); // only adopt the new array into the cache once it's actually durable
        items = next;
        return record;
      }),

    update: (idempotencyKey, patch, now) =>
      serialize(async () => {
        const current = await ensureLoaded();
        const next = current.map((i) => (i.idempotencyKey === idempotencyKey ? { ...i, ...patch, updatedAt: now } : i));
        await saveQueueFile(path, next);
        items = next;
      }),

    get: (idempotencyKey) => serialize(async () => (await ensureLoaded()).find((i) => i.idempotencyKey === idempotencyKey)),
    pending: () => serialize(async () => (await ensureLoaded()).filter((i) => i.status === "pending")),
  };
}

/** In-memory queue (same contract, no disk) — for callers/tests that don't need persistence. */
export function createMemoryOutboundQueue(): OutboundQueue {
  const items: QueueItem[] = [];
  return {
    async enqueue(item, now) {
      const existing = items.find((i) => i.idempotencyKey === item.idempotencyKey);
      if (existing) return existing;
      const record: QueueItem = { ...item, status: "pending", attempts: 0, createdAt: now, updatedAt: now };
      items.push(record);
      return record;
    },
    async update(idempotencyKey, patch, now) {
      const i = items.findIndex((x) => x.idempotencyKey === idempotencyKey);
      if (i !== -1) items[i] = { ...items[i]!, ...patch, updatedAt: now };
    },
    async get(idempotencyKey) {
      return items.find((i) => i.idempotencyKey === idempotencyKey);
    },
    async pending() {
      return items.filter((i) => i.status === "pending");
    },
  };
}
