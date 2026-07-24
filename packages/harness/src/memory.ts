import { createClient, type Client } from "@libsql/client";
import type { Memory, Turn } from "@wappy/core";

export type LibsqlMemoryOptions =
  | {
      /** `:memory:`, a local `file:...` path, or a remote `libsql://...`/`https://...` URL. */
      url: string;
      authToken?: string;
    }
  | { client: Client };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  contactId TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT,
  timestamp INTEGER NOT NULL,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_turns_contact_ts ON turns(contactId, timestamp);
`;

function rowToTurn(row: Record<string, unknown>): Turn {
  return {
    id: row.id as string,
    contactId: row.contactId as string,
    role: row.role as Turn["role"],
    ...(row.text !== null ? { text: row.text as string } : {}),
    timestamp: row.timestamp as number,
    ...(row.meta !== null ? { meta: JSON.parse(row.meta as string) as Record<string, unknown> } : {}),
  };
}

/** LibSQL-backed Memory (§2.1 "default memory = LibSQL/SQLite local file"). Works with a local file, `:memory:`, or a remote libsql URL — same client either way. */
export function createLibsqlMemory(opts: LibsqlMemoryOptions): Memory {
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
    async load(contactId) {
      await ensureSchema();
      const result = await client.execute({
        sql: "SELECT id, contactId, role, text, timestamp, meta FROM turns WHERE contactId = ? ORDER BY timestamp ASC, rowid ASC",
        args: [contactId],
      });
      return result.rows.map((r) => rowToTurn(r as unknown as Record<string, unknown>));
    },

    async append(turn) {
      await ensureSchema();
      // Idempotent by id: a crash-recovery replay of the same logical turn must never duplicate it
      // (§10, matching the outbound queue's idempotency pattern) — first write wins, silently.
      await client.execute({
        sql: "INSERT INTO turns (id, contactId, role, text, timestamp, meta) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
        args: [turn.id, turn.contactId, turn.role, turn.text ?? null, turn.timestamp, turn.meta ? JSON.stringify(turn.meta) : null],
      });
    },

    async recall(contactId, query) {
      await ensureSchema();
      // Naive LITERAL substring recall for v0.1 — embedding-based semantic search is RAG's job
      // (M7/M8). LIKE's own wildcards (%, _) are escaped so a query containing them is matched
      // literally, not as a pattern.
      const escaped = query.replace(/[%_\\]/g, "\\$&");
      const result = await client.execute({
        sql: "SELECT text FROM turns WHERE contactId = ? AND text IS NOT NULL AND lower(text) LIKE lower(?) ESCAPE '\\' ORDER BY timestamp DESC",
        args: [contactId, `%${escaped}%`],
      });
      return result.rows.map((r) => (r as unknown as { text: string }).text);
    },
  };
}
