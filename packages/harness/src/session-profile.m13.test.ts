import { describe, expect, test } from "vitest";
import { createClient } from "@libsql/client";
import { createLibsqlSessionProfileStore } from "./session-profile.js";

describe("createLibsqlSessionProfileStore", () => {
  test("get() returns undefined for a contact with no profile", async () => {
    const store = createLibsqlSessionProfileStore({ url: ":memory:" });
    expect(await store.get("c1", 1000)).toBeUndefined();
  });

  test("set() then get() (before expiry) round-trips the full shape", async () => {
    const store = createLibsqlSessionProfileStore({ url: ":memory:" });
    await store.set({ contactId: "c1", facts: { name: "Jane" }, currentState: "picking a size", summary: "browsing candles", expiresAt: 5000 });
    expect(await store.get("c1", 1000)).toEqual({ contactId: "c1", facts: { name: "Jane" }, currentState: "picking a size", summary: "browsing candles", expiresAt: 5000 });
  });

  test("currentState/summary are omitted from the result when never set", async () => {
    const store = createLibsqlSessionProfileStore({ url: ":memory:" });
    await store.set({ contactId: "c1", facts: {}, expiresAt: 5000 });
    const p = await store.get("c1", 1000);
    expect(p).toEqual({ contactId: "c1", facts: {}, expiresAt: 5000 });
    expect(p).not.toHaveProperty("currentState");
    expect(p).not.toHaveProperty("summary");
  });

  test("a profile past expiresAt is treated as absent, not returned (TTL expiry)", async () => {
    const store = createLibsqlSessionProfileStore({ url: ":memory:" });
    await store.set({ contactId: "c1", facts: { name: "Jane" }, expiresAt: 1000 });
    expect(await store.get("c1", 1000)).toBeDefined(); // exactly at expiresAt: not yet expired
    expect(await store.get("c1", 1001)).toBeUndefined(); // one ms past: expired
  });

  test("set() after an expired read is a plain upsert — no stale state leaks through", async () => {
    const store = createLibsqlSessionProfileStore({ url: ":memory:" });
    await store.set({ contactId: "c1", facts: { name: "Jane", location: "NYC" }, currentState: "old thread", expiresAt: 1000 });
    expect(await store.get("c1", 2000)).toBeUndefined(); // expired

    // A fresh session starting after expiry writes a fresh profile, not a merge with the old one.
    await store.set({ contactId: "c1", facts: { name: "Sam" }, expiresAt: 9000 });
    expect(await store.get("c1", 2000)).toEqual({ contactId: "c1", facts: { name: "Sam" }, expiresAt: 9000 });
  });

  test("set() overwrites an existing, still-live profile (upsert, not insert-only)", async () => {
    const store = createLibsqlSessionProfileStore({ url: ":memory:" });
    await store.set({ contactId: "c1", facts: { name: "Jane" }, expiresAt: 5000 });
    await store.set({ contactId: "c1", facts: { name: "Jane", location: "NYC" }, currentState: "checking out", expiresAt: 6000 });
    expect(await store.get("c1", 1000)).toEqual({ contactId: "c1", facts: { name: "Jane", location: "NYC" }, currentState: "checking out", expiresAt: 6000 });
  });

  test("profiles are scoped per contact — one contact's profile never leaks into another's get()", async () => {
    const store = createLibsqlSessionProfileStore({ url: ":memory:" });
    await store.set({ contactId: "c1", facts: { name: "Jane" }, expiresAt: 5000 });
    await store.set({ contactId: "c2", facts: { name: "Sam" }, expiresAt: 5000 });
    expect((await store.get("c1", 1000))?.facts).toEqual({ name: "Jane" });
    expect((await store.get("c2", 1000))?.facts).toEqual({ name: "Sam" });
  });
});

describe("createLibsqlSessionProfileStore — schema init resilience", () => {
  test("a transient failure creating the schema is retried on the next call, not permanently cached", async () => {
    const client = createClient({ url: ":memory:" });
    const originalExecuteMultiple = client.executeMultiple.bind(client);
    let executeMultipleCalls = 0;
    client.executeMultiple = (sql: string) => {
      executeMultipleCalls++;
      if (executeMultipleCalls === 1) return Promise.reject(new Error("transient connection blip"));
      return originalExecuteMultiple(sql);
    };
    const store = createLibsqlSessionProfileStore({ client });

    await expect(store.get("c1", 0)).rejects.toThrow("transient connection blip");
    // A second call must retry schema creation rather than replaying the same cached rejection forever.
    expect(await store.get("c1", 0)).toBeUndefined();
    expect(executeMultipleCalls).toBe(2);
  });
});
