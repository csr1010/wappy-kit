import { afterEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileOutboundQueue, createMemoryOutboundQueue } from "./queue.js";

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "wappy-wa-queue-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

for (const [label, makeQueue] of [
  ["createFileOutboundQueue", () => createFileOutboundQueue(join(tmpDir(), "queue.json"))],
  ["createMemoryOutboundQueue", () => createMemoryOutboundQueue()],
] as const) {
  describe(label, () => {
    test("enqueue creates a pending item", async () => {
      const q = makeQueue();
      const item = await q.enqueue({ idempotencyKey: "k1", to: "c1", payload: { type: "text" } }, 0);
      expect(item).toMatchObject({ idempotencyKey: "k1", status: "pending", attempts: 0 });
    });

    test("enqueue with the same key is idempotent — returns the existing item, doesn't duplicate", async () => {
      const q = makeQueue();
      const first = await q.enqueue({ idempotencyKey: "k1", to: "c1", payload: { type: "text" } }, 0);
      const second = await q.enqueue({ idempotencyKey: "k1", to: "c1", payload: { type: "text" } }, 100);
      expect(second).toEqual(first);
      expect(await q.pending()).toHaveLength(1);
    });

    test("update() patches the item and moves it out of pending() once no longer pending", async () => {
      const q = makeQueue();
      await q.enqueue({ idempotencyKey: "k1", to: "c1", payload: {} }, 0);
      await q.update("k1", { status: "sent", metaMessageId: "wamid.1" }, 5);
      expect(await q.get("k1")).toMatchObject({ status: "sent", metaMessageId: "wamid.1", updatedAt: 5 });
      expect(await q.pending()).toEqual([]);
    });

    test("get() on an unknown key returns undefined", async () => {
      expect(await makeQueue().get("nope")).toBeUndefined();
    });

    test("update() only touches the matching item, others are untouched", async () => {
      const q = makeQueue();
      await q.enqueue({ idempotencyKey: "k1", to: "c1", payload: {} }, 0);
      await q.enqueue({ idempotencyKey: "k2", to: "c2", payload: {} }, 0);
      await q.update("k1", { status: "sent" }, 5);
      expect((await q.get("k1"))?.status).toBe("sent");
      expect(await q.get("k2")).toMatchObject({ status: "pending", updatedAt: 0 });
    });

    test("update() on an unknown key is a no-op, not a throw", async () => {
      await expect(makeQueue().update("nope", { status: "sent" }, 0)).resolves.toBeUndefined();
    });

    test("concurrent enqueue() calls for different keys don't clobber each other", async () => {
      const q = makeQueue();
      await Promise.all([
        q.enqueue({ idempotencyKey: "k1", to: "c1", payload: {} }, 0),
        q.enqueue({ idempotencyKey: "k2", to: "c2", payload: {} }, 0),
        q.enqueue({ idempotencyKey: "k3", to: "c3", payload: {} }, 0),
      ]);
      expect((await q.pending()).map((i) => i.idempotencyKey).sort()).toEqual(["k1", "k2", "k3"]);
    });
  });
}

describe("createFileOutboundQueue — survives restart", () => {
  test("a fresh queue instance on the same path sees items persisted by a previous instance", async () => {
    const path = join(tmpDir(), "queue.json");
    const q1 = createFileOutboundQueue(path);
    await q1.enqueue({ idempotencyKey: "k1", to: "c1", payload: { type: "text" } }, 0);
    await q1.update("k1", { status: "sent", metaMessageId: "wamid.1" }, 1);

    const q2 = createFileOutboundQueue(path); // simulates a process restart
    expect(await q2.get("k1")).toMatchObject({ status: "sent", metaMessageId: "wamid.1" });
  });

  test("re-enqueuing after a simulated crash-restart doesn't create a duplicate or re-send a completed item", async () => {
    const path = join(tmpDir(), "queue.json");
    const q1 = createFileOutboundQueue(path);
    await q1.enqueue({ idempotencyKey: "reply-to:wamid.inbound1", to: "c1", payload: { type: "text" } }, 0);
    await q1.update("reply-to:wamid.inbound1", { status: "sent", metaMessageId: "wamid.out1" }, 1);

    // Process crashes and restarts; the same logical handler runs again for the same inbound message.
    const q2 = createFileOutboundQueue(path);
    const resubmitted = await q2.enqueue({ idempotencyKey: "reply-to:wamid.inbound1", to: "c1", payload: { type: "text" } }, 100);
    expect(resubmitted.status).toBe("sent"); // caller can see it's already done and skip re-sending
    expect(await q2.pending()).toEqual([]);
  });

  test("a corrupt (invalid JSON) queue file starts fresh instead of crashing the process", async () => {
    const path = join(tmpDir(), "queue.json");
    writeFileSync(path, "{ not json");
    const q = createFileOutboundQueue(path);
    expect(await q.pending()).toEqual([]);
    expect((await q.enqueue({ idempotencyKey: "k1", to: "c1", payload: {} }, 0)).status).toBe("pending");
  });

  test("a queue file whose JSON is valid but not the expected shape ({items: [...]}) also starts fresh", async () => {
    const path = join(tmpDir(), "queue.json");
    writeFileSync(path, JSON.stringify({ items: "not-an-array" }));
    expect(await createFileOutboundQueue(path).pending()).toEqual([]);

    const path2 = join(tmpDir(), "queue2.json");
    writeFileSync(path2, "{}");
    expect(await createFileOutboundQueue(path2).pending()).toEqual([]);
  });

  test("a rename failure cleans up the temp file and rethrows, leaving no orphaned .tmp file", async () => {
    const dir = tmpDir();
    const path = join(dir, "queue.json");
    // A non-empty directory at the destination makes rename(tmp, path) fail, unlike a normal write success.
    mkdirSync(path);
    writeFileSync(join(path, "keepme"), "x");
    await expect(createFileOutboundQueue(path).enqueue({ idempotencyKey: "k1", to: "c1", payload: {} }, 0)).rejects.toThrow();
    expect(readdirSync(dir).filter((n) => n.includes(".tmp"))).toEqual([]);
  });

  test("a failed write doesn't leave the in-memory cache believing an unsaved item was persisted", async () => {
    const dir = tmpDir();
    const path = join(dir, "queue.json");
    const q = createFileOutboundQueue(path);
    await q.enqueue({ idempotencyKey: "k1", to: "c1", payload: {} }, 0); // one real, successfully-persisted item

    // Make the NEXT save fail by replacing the queue file with a non-empty directory of the same name.
    rmSync(path, { force: true });
    mkdirSync(path);
    writeFileSync(join(path, "keepme"), "x");
    await expect(q.enqueue({ idempotencyKey: "k2", to: "c1", payload: {} }, 1)).rejects.toThrow();

    // The failed enqueue must not appear in this instance's own in-memory view of the queue —
    // otherwise a caller believing k2 was durably queued would be wrong (it never hit disk).
    expect((await q.pending()).map((i) => i.idempotencyKey)).toEqual(["k1"]);
  });

  test("no leftover temp file after a write", async () => {
    const dir = tmpDir();
    const path = join(dir, "queue.json");
    await createFileOutboundQueue(path).enqueue({ idempotencyKey: "k1", to: "c1", payload: {} }, 0);
    expect(readdirSync(dir)).toEqual(["queue.json"]);
  });
});
