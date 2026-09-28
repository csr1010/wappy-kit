import { describe, expect, test, vi } from "vitest";
import type { Clock } from "@wappy_ai/core";
import { createGoogleOAuthPlugin } from "./plugin.js";
import { createGoogleTokenStore } from "./token-store.js";
import type { GoogleOAuthConfig } from "./oauth.js";

function fakeClock(now: number): Clock {
  return { now: () => now, setTimeout: () => 0, clearTimeout: () => {}, sleep: async () => {} };
}

const config: GoogleOAuthConfig = { clientId: "c", clientSecret: "s", redirectUri: "http://localhost:3001/google/callback" };

describe("createGoogleOAuthPlugin", () => {
  test("label and callbackPath are fixed", () => {
    const plugin = createGoogleOAuthPlugin({ config, tokenStore: createGoogleTokenStore({ url: ":memory:" }), clock: fakeClock(0) });
    expect(plugin.label).toBe("Google");
    expect(plugin.callbackPath).toBe("/google/callback");
  });

  test("isAvailable is true only when both clientId and clientSecret are set", () => {
    const tokenStore = createGoogleTokenStore({ url: ":memory:" });
    expect(createGoogleOAuthPlugin({ config, tokenStore, clock: fakeClock(0) }).isAvailable()).toBe(true);
    expect(createGoogleOAuthPlugin({ config: { ...config, clientId: "" }, tokenStore, clock: fakeClock(0) }).isAvailable()).toBe(false);
  });

  test("isConnected reflects whether the token store actually has tokens", async () => {
    const tokenStore = createGoogleTokenStore({ url: ":memory:" });
    const plugin = createGoogleOAuthPlugin({ config, tokenStore, clock: fakeClock(0) });
    expect(await plugin.isConnected()).toBe(false);
    await tokenStore.set({ accessToken: "at", refreshToken: "rt", expiresAt: 999 });
    expect(await plugin.isConnected()).toBe(true);
  });

  test("authUrl() returns a real Google consent URL", () => {
    const plugin = createGoogleOAuthPlugin({ config, tokenStore: createGoogleTokenStore({ url: ":memory:" }), clock: fakeClock(0) });
    expect(plugin.authUrl()).toContain("accounts.google.com");
  });

  test("handleCallback exchanges the code and stores the resulting tokens", async () => {
    const tokenStore = createGoogleTokenStore({ url: ":memory:" });
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 }) }) as unknown as Response);
    const plugin = createGoogleOAuthPlugin({ config, tokenStore, clock: fakeClock(1000), fetchImpl });

    const handled = await plugin.handleCallback(new URL("http://localhost/google/callback?code=abc"));

    expect(handled).toBe(true);
    expect(await tokenStore.get()).toEqual({ accessToken: "at-1", refreshToken: "rt-1", expiresAt: 1000 + 3_600_000 });
  });

  test("handleCallback with no code returns false, stores nothing", async () => {
    const tokenStore = createGoogleTokenStore({ url: ":memory:" });
    const plugin = createGoogleOAuthPlugin({ config, tokenStore, clock: fakeClock(0) });
    const handled = await plugin.handleCallback(new URL("http://localhost/google/callback"));
    expect(handled).toBe(false);
    expect(await tokenStore.get()).toBeUndefined();
  });
});
