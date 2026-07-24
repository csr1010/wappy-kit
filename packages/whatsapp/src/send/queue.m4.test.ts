import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
    test("enqueue creates a pending item", () => {
      const q = makeQueue();
      const item = q.enqueue({ idempotencyKey: "k1", to: "c1", payload: { type: "text" } }, 0);
      expect(item).toMatchObject({ idempotencyKey: "k1", status: "pending", attempts: 0 });
    });

    test("enqueue with the same key is idempotent — returns the existing item, doesn't duplicate", () => {
      const q = makeQueue();
      const first = q.enqueue({ idempotencyKey: "k1", to: "c1", payload: { type: "text" } }, 0);
      const second = q.enqueue({ idempotencyKey: "k1", to: "c1", payload: { type: "text" } }, 100);
      expect(second).toEqual(first);
      expect(q.pending()).toHaveLength(1);
    });

    test("update() patches the item and moves it out of pending() once no longer pending", () => {
      const q = makeQueue();
      q.enqueue({ idempotencyKey: "k1", to: "c1", payload: {} }, 0);
      q.update("k1", { status: "sent", metaMessageId: "wamid.1" }, 5);
      expect(q.get("k1")).toMatchObject({ status: "sent", metaMessageId: "wamid.1", updatedAt: 5 });
      expect(q.pending()).toEqual([]);
    });

    test("get() on an unknown key returns undefined", () => {
      expect(makeQueue().get("nope")).toBeUndefined();
    });
  });
}

describe("createFileOutboundQueue — survives restart", () => {
  test("a fresh queue instance on the same path sees items persisted by a previous instance", () => {
    const path = join(tmpDir(), "queue.json");
    const q1 = createFileOutboundQueue(path);
    q1.enqueue({ idempotencyKey: "k1", to: "c1", payload: { type: "text" } }, 0);
    q1.update("k1", { status: "sent", metaMessageId: "wamid.1" }, 1);

    const q2 = createFileOutboundQueue(path); // simulates a process restart
    expect(q2.get("k1")).toMatchObject({ status: "sent", metaMessageId: "wamid.1" });
  });

  test("re-enqueuing after a simulated crash-restart doesn't create a duplicate or re-send a completed item", () => {
    const path = join(tmpDir(), "queue.json");
    const q1 = createFileOutboundQueue(path);
    q1.enqueue({ idempotencyKey: "reply-to:wamid.inbound1", to: "c1", payload: { type: "text" } }, 0);
    q1.update("reply-to:wamid.inbound1", { status: "sent", metaMessageId: "wamid.out1" }, 1);

    // Process crashes and restarts; the same logical handler runs again for the same inbound message.
    const q2 = createFileOutboundQueue(path);
    const resubmitted = q2.enqueue({ idempotencyKey: "reply-to:wamid.inbound1", to: "c1", payload: { type: "text" } }, 100);
    expect(resubmitted.status).toBe("sent"); // caller can see it's already done and skip re-sending
    expect(q2.pending()).toEqual([]);
  });

  test("a corrupt queue file starts fresh instead of crashing the process", () => {
    const path = join(tmpDir(), "queue.json");
    writeFileSync(path, "{ not json");
    const q = createFileOutboundQueue(path);
    expect(q.pending()).toEqual([]);
    expect(q.enqueue({ idempotencyKey: "k1", to: "c1", payload: {} }, 0).status).toBe("pending");
  });

  test("no leftover temp file after a write", () => {
    const dir = tmpDir();
    const path = join(dir, "queue.json");
    createFileOutboundQueue(path).enqueue({ idempotencyKey: "k1", to: "c1", payload: {} }, 0);
    expect(readdirSync(dir)).toEqual(["queue.json"]);
  });
});
