import { describe, expect, test, vi } from "vitest";
import { buildAuthUrl, exchangeCodeForTokens, isExpired, refreshAccessToken, type GoogleOAuthConfig } from "./oauth.js";

const config: GoogleOAuthConfig = { clientId: "client-123", clientSecret: "secret-abc", redirectUri: "http://localhost:3001/google/callback" };

function fakeFetch(response: unknown, ok = true, status = 200) {
  return vi.fn(async () => ({ ok, status, json: async () => response }) as unknown as Response);
}

describe("buildAuthUrl", () => {
  test("includes client id, redirect uri, response_type=code, full-read scopes, offline+consent", () => {
    const url = new URL(buildAuthUrl(config));
    expect(url.hostname).toBe("accounts.google.com");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    const scopes = url.searchParams.get("scope")!.split(" ");
    expect(scopes).toContain("https://www.googleapis.com/auth/calendar.readonly");
    expect(scopes).toContain("https://www.googleapis.com/auth/gmail.readonly");
  });

  test("custom scopes override the default full-read scopes", () => {
    const url = new URL(buildAuthUrl({ ...config, scopes: ["https://example.com/scope"] }));
    expect(url.searchParams.get("scope")).toBe("https://example.com/scope");
  });
});

describe("exchangeCodeForTokens", () => {
  test("posts the real Google token endpoint with the authorization_code grant", async () => {
    const fetchImpl = fakeFetch({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 });
    const tokens = await exchangeCodeForTokens(config, "auth-code-xyz", 1_000_000, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith("https://oauth2.googleapis.com/token", expect.objectContaining({ method: "POST" }));
    const body = (fetchImpl.mock.calls[0]![1] as { body: string }).body;
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("code=auth-code-xyz");
    expect(tokens).toEqual({ accessToken: "at-1", refreshToken: "rt-1", expiresAt: 1_000_000 + 3_600_000 });
  });

  test("throws a clear error when Google doesn't return a refresh token", async () => {
    const fetchImpl = fakeFetch({ access_token: "at-1", expires_in: 3600 });
    await expect(exchangeCodeForTokens(config, "code", 0, fetchImpl)).rejects.toThrow(/refresh token/);
  });

  test("throws with Google's own error description on a non-ok response", async () => {
    const fetchImpl = fakeFetch({ error: "invalid_grant", error_description: "Bad Request" }, false, 400);
    await expect(exchangeCodeForTokens(config, "bad-code", 0, fetchImpl)).rejects.toThrow(/invalid_grant/);
  });
});

describe("refreshAccessToken", () => {
  test("posts the refresh_token grant and reuses the SAME refresh token in the result", async () => {
    const fetchImpl = fakeFetch({ access_token: "at-2", expires_in: 1800 });
    const tokens = await refreshAccessToken(config, "rt-existing", 5000, fetchImpl);
    const body = (fetchImpl.mock.calls[0]![1] as { body: string }).body;
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=rt-existing");
    expect(tokens).toEqual({ accessToken: "at-2", refreshToken: "rt-existing", expiresAt: 5000 + 1_800_000 });
  });
});

describe("isExpired", () => {
  test("true once within the 60s safety margin of expiresAt, not just strictly past it", () => {
    expect(isExpired({ expiresAt: 100_000 }, 100_000 - 60_000)).toBe(true);
    expect(isExpired({ expiresAt: 100_000 }, 100_000 - 61_000)).toBe(false);
  });
});
