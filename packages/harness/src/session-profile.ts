import { createClient, type Client } from "@libsql/client";
import type { SessionProfile, SessionProfileStore } from "@wappy/core";

export type LibsqlSessionProfileStoreOptions =
  | {
      /** `:memory:`, a local `file:...` path, or a remote `libsql://...`/`https://...` URL. */
      url: string;
      authToken?: string;
    }
  | { client: Client };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS session_profiles (
  contactId TEXT PRIMARY KEY,
  facts TEXT NOT NULL,
  currentState TEXT,
  summary TEXT,
  expiresAt INTEGER NOT NULL
);
`;

function rowToProfile(row: Record<string, unknown>): SessionProfile {
  return {
    contactId: row.contactId as string,
    facts: JSON.parse(row.facts as string) as Record<string, string>,
    ...(row.currentState !== null ? { currentState: row.currentState as string } : {}),
    ...(row.summary !== null ? { summary: row.summary as string } : {}),
    expiresAt: row.expiresAt as number,
  };
}

/**
 * M13: LibSQL-backed `SessionProfileStore` — same client/schema pattern as `memory.ts`'s
 * `createLibsqlMemory`, a separate table (`session_profiles`) since this is a distinct concern
 * from turn history, not an overload of it.
 */
export function createLibsqlSessionProfileStore(opts: LibsqlSessionProfileStoreOptions): SessionProfileStore {
  const client: Client = "client" in opts ? opts.client : createClient({ url: opts.url, authToken: opts.authToken });
  let ready: Promise<void> | undefined;
  const ensureSchema = (): Promise<void> => {
    if (!ready) {
      ready = client.executeMultiple(SCHEMA).catch((e: unknown) => {
        ready = undefined; // let the next call retry instead of permanently caching a transient failure
        throw e;
      });
    }
    return ready;
  };

  return {
    async get(contactId, now) {
      await ensureSchema();
      const result = await client.execute({
        sql: "SELECT contactId, facts, currentState, summary, expiresAt FROM session_profiles WHERE contactId = ?",
        args: [contactId],
      });
      const row = result.rows[0];
      if (!row) return undefined;
      const profile = rowToProfile(row as unknown as Record<string, unknown>);
      // An expired row is treated as absent, not returned and not eagerly deleted — the next
      // set() upserts over it same as any other write, so there's nothing extra to clean up here.
      if (now > profile.expiresAt) return undefined;
      return profile;
    },

    async set(profile) {
      await ensureSchema();
      await client.execute({
        sql: "INSERT INTO session_profiles (contactId, facts, currentState, summary, expiresAt) VALUES (?, ?, ?, ?, ?) ON CONFLICT(contactId) DO UPDATE SET facts = excluded.facts, currentState = excluded.currentState, summary = excluded.summary, expiresAt = excluded.expiresAt",
        args: [profile.contactId, JSON.stringify(profile.facts), profile.currentState ?? null, profile.summary ?? null, profile.expiresAt],
      });
    },
  };
}
