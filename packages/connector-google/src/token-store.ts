import { createClient, type Client } from "@libsql/client";
import type { GoogleTokens } from "./oauth.js";

/**
 * A single-operator connection, not per-contact — this connector, per the plan, is scoped to one
 * operator connecting their own single Google account (a WhatsApp text thread can't complete a
 * browser OAuth flow). One row, same LibSQL/`ensureSchema()` pattern as
 * `packages/harness/src/session-profile.ts`.
 */
export type GoogleTokenStoreOptions = { url: string; authToken?: string } | { client: Client };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS google_tokens (
  id TEXT PRIMARY KEY DEFAULT 'default',
  accessToken TEXT NOT NULL,
  refreshToken TEXT NOT NULL,
  expiresAt INTEGER NOT NULL
);
`;

export interface GoogleTokenStore {
  get(): Promise<GoogleTokens | undefined>;
  set(tokens: GoogleTokens): Promise<void>;
}

export function createGoogleTokenStore(opts: GoogleTokenStoreOptions): GoogleTokenStore {
  const client: Client = "client" in opts ? opts.client : createClient({ url: opts.url, authToken: opts.authToken });
  let ready: Promise<void> | undefined;
  const ensureSchema = (): Promise<void> => {
    if (!ready) {
      ready = client.executeMultiple(SCHEMA).catch((e: unknown) => {
        ready = undefined;
        throw e;
      });
    }
    return ready;
  };

  return {
    async get() {
      await ensureSchema();
      const result = await client.execute({ sql: "SELECT accessToken, refreshToken, expiresAt FROM google_tokens WHERE id = 'default'" });
      const row = result.rows[0];
      if (!row) return undefined;
      return { accessToken: row.accessToken as string, refreshToken: row.refreshToken as string, expiresAt: row.expiresAt as number };
    },

    async set(tokens) {
      await ensureSchema();
      await client.execute({
        sql: "INSERT INTO google_tokens (id, accessToken, refreshToken, expiresAt) VALUES ('default', ?, ?, ?) ON CONFLICT(id) DO UPDATE SET accessToken = excluded.accessToken, refreshToken = excluded.refreshToken, expiresAt = excluded.expiresAt",
        args: [tokens.accessToken, tokens.refreshToken, tokens.expiresAt],
      });
    },
  };
}
