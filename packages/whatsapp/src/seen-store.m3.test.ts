import { describe, expect, test } from "vitest";
import { createMemorySeenStore } from "./seen-store.js";

describe("createMemorySeenStore", () => {
  test("first sighting -> true, repeats within TTL -> false", async () => {
    const store = createMemorySeenStore({ ttlMs: 1000 });
    expect(await store.checkAndSet("m1", 0)).toBe(true);
    expect(await store.checkAndSet("m1", 100)).toBe(false);
    expect(await store.checkAndSet("m1", 999)).toBe(false);
  });

  test("after the TTL elapses, the same id is treated as new again", async () => {
    const store = createMemorySeenStore({ ttlMs: 1000 });
    expect(await store.checkAndSet("m1", 0)).toBe(true);
    expect(await store.checkAndSet("m1", 1000)).toBe(true);
  });

  test("different ids are independent", async () => {
    const store = createMemorySeenStore();
    expect(await store.checkAndSet("a", 0)).toBe(true);
    expect(await store.checkAndSet("b", 0)).toBe(true);
  });

  test("50 concurrent checkAndSet calls for the same id: exactly one winner", async () => {
    const store = createMemorySeenStore();
    const results = await Promise.all(Array.from({ length: 50 }, () => store.checkAndSet("dup", 0)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test("expired entries are swept, not kept forever (bounded memory)", async () => {
    const store = createMemorySeenStore({ ttlMs: 100 });
    for (let i = 0; i < 500; i++) await store.checkAndSet(`old-${i}`, 0);
    expect(store.size()).toBe(500);

    // Long after every one of those expired, one more call should sweep them all away.
    await store.checkAndSet("new-id", 10_000);
    expect(store.size()).toBe(1);
  });

  test("has() peeks without marking — checkAndSet still returns true afterward", async () => {
    const store = createMemorySeenStore();
    expect(await store.has("m1", 0)).toBe(false);
    expect(await store.has("m1", 0)).toBe(false); // still false: has() never marks
    expect(await store.checkAndSet("m1", 0)).toBe(true);
    expect(await store.has("m1", 0)).toBe(true);
  });

  test("has() respects TTL expiry the same as checkAndSet", async () => {
    const store = createMemorySeenStore({ ttlMs: 100 });
    await store.checkAndSet("m1", 0);
    expect(await store.has("m1", 99)).toBe(true);
    expect(await store.has("m1", 100)).toBe(false);
  });

  test("default TTL is 24h", async () => {
    const store = createMemorySeenStore();
    expect(await store.checkAndSet("m1", 0)).toBe(true);
    expect(await store.checkAndSet("m1", 24 * 60 * 60 * 1000 - 1)).toBe(false);
    expect(await store.checkAndSet("m1", 24 * 60 * 60 * 1000)).toBe(true);
  });
});
