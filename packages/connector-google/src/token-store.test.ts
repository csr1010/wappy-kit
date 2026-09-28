import { describe, expect, test } from "vitest";
import { createGoogleTokenStore } from "./token-store.js";

describe("createGoogleTokenStore", () => {
  test("get() returns undefined before anything is set", async () => {
    const store = createGoogleTokenStore({ url: ":memory:" });
    expect(await store.get()).toBeUndefined();
  });

  test("set() then get() round-trips", async () => {
    const store = createGoogleTokenStore({ url: ":memory:" });
    await store.set({ accessToken: "at", refreshToken: "rt", expiresAt: 12345 });
    expect(await store.get()).toEqual({ accessToken: "at", refreshToken: "rt", expiresAt: 12345 });
  });

  test("set() again overwrites the single row rather than adding a second one", async () => {
    const store = createGoogleTokenStore({ url: ":memory:" });
    await store.set({ accessToken: "at-1", refreshToken: "rt-1", expiresAt: 1000 });
    await store.set({ accessToken: "at-2", refreshToken: "rt-2", expiresAt: 2000 });
    expect(await store.get()).toEqual({ accessToken: "at-2", refreshToken: "rt-2", expiresAt: 2000 });
  });
});
