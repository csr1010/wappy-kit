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

  test("default TTL is 24h", async () => {
    const store = createMemorySeenStore();
    expect(await store.checkAndSet("m1", 0)).toBe(true);
    expect(await store.checkAndSet("m1", 24 * 60 * 60 * 1000 - 1)).toBe(false);
    expect(await store.checkAndSet("m1", 24 * 60 * 60 * 1000)).toBe(true);
  });
});
