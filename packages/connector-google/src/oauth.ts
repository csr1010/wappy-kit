/**
 * Bring-your-own Google Cloud OAuth client — the one unavoidable manual step (Google requires every
 * app to be registered under someone's own Cloud project; see GOOGLE_SETUP.md, generated when the
 * productivity-agent interview step is "yes"). The actual "connect" click happens in the browser,
 * on the same local task-UI page @wappy_ai/productivity already serves — see `plugin.ts`.
 *
 * Real Google endpoints (not guessed): `https://accounts.google.com/o/oauth2/v2/auth` for consent,
 * `https://oauth2.googleapis.com/token` for the code/refresh-token exchange — both documented,
 * stable Google Identity endpoints.
 */

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Must exactly match a redirect URI registered on the Google Cloud OAuth client — the task UI
   * server's own `/google/callback` route (see `plugin.ts`). */
  redirectUri: string;
  /** Full read access, not narrowed — confirmed with the user directly. `calendar.readonly` and
   * `gmail.readonly` are Google's own full-read scopes ("no write/delete", not "less to read"). */
  scopes?: string[];
}

const DEFAULT_SCOPES = ["https://www.googleapis.com/auth/calendar.readonly", "https://www.googleapis.com/auth/gmail.readonly"];

export function buildAuthUrl(config: GoogleOAuthConfig): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", (config.scopes ?? DEFAULT_SCOPES).join(" "));
  // offline + consent: a refresh token is only ever issued the FIRST time a user consents unless
  // prompt=consent forces Google to re-show the consent screen and re-issue one — needed here since
  // this is a one-time, non-interactive setup, not a "log in every session" flow.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  expiresAt: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  error?: string;
  error_description?: string;
}

export type FetchImpl = typeof fetch;

async function postToken(body: Record<string, string>, fetchImpl: FetchImpl): Promise<TokenResponse> {
  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const json = (await res.json()) as TokenResponse;
  if (!res.ok || json.error) throw new Error(`Google token endpoint: ${json.error ?? res.status} ${json.error_description ?? ""}`.trim());
  return json;
}

export async function exchangeCodeForTokens(config: GoogleOAuthConfig, code: string, now: number, fetchImpl: FetchImpl = fetch): Promise<GoogleTokens> {
  const json = await postToken(
    { code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.redirectUri, grant_type: "authorization_code" },
    fetchImpl,
  );
  if (!json.refresh_token) {
    throw new Error("Google didn't return a refresh token — this usually means consent was already granted before without access_type=offline+prompt=consent; revoke access at https://myaccount.google.com/permissions and try connecting again.");
  }
  return { accessToken: json.access_token, refreshToken: json.refresh_token, expiresAt: now + json.expires_in * 1000 };
}

/** A fresh access token from a stored refresh token — the refresh token itself never expires (until
 * revoked), so the returned tokens always reuse the SAME refresh token, only accessToken/expiresAt
 * change. */
export async function refreshAccessToken(config: GoogleOAuthConfig, refreshToken: string, now: number, fetchImpl: FetchImpl = fetch): Promise<GoogleTokens> {
  const json = await postToken({ refresh_token: refreshToken, client_id: config.clientId, client_secret: config.clientSecret, grant_type: "refresh_token" }, fetchImpl);
  return { accessToken: json.access_token, refreshToken, expiresAt: now + json.expires_in * 1000 };
}

/** 60s safety margin — never send a request with a token that's about to expire mid-flight. */
const EXPIRY_MARGIN_MS = 60_000;

export function isExpired(tokens: Pick<GoogleTokens, "expiresAt">, now: number): boolean {
  return now >= tokens.expiresAt - EXPIRY_MARGIN_MS;
}
