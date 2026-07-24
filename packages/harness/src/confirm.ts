import type { Client } from "@libsql/client";
import type { Clock } from "@wappy/core";

/** `InboundMessage.selectionId` values a confirm/cancel button reply carries (§9 T8.5) — reserved,
 * stable ids agent.ts's confirm-flow branch keys off, never off free text (matching core's own
 * "routing must key off selectionId, never text" convention for button replies). */
export const CONFIRM_SELECTION_ID = "confirm";
export const CANCEL_SELECTION_ID = "cancel";

export interface PendingConfirmation {
  id: string;
  toolName: string;
  args: unknown;
  /** Human-readable description of the pending action, e.g. `cancelOrder with {"id":"1001"}` — used
   * in both the confirmation prompt and the "Done — ..." / "I've canceled ..." follow-up replies. */
  summary: string;
  createdAt: number;
  expiresAt: number;
}

export interface ConfirmFlowOptions {
  client: Client;
  clock: Clock;
  /** How long a pending confirmation stays valid before it's treated as expired (never auto-executed
   * or auto-canceled — just silently gone, so a stale "confirm" months later can't fire an old
   * write). Default 5 minutes. */
  ttlMs?: number;
  idGenerator?: () => string;
}

export interface ConfirmFlow {
  /** Persists a pending confirmation for `contactId`, superseding (replacing outright — at most one
   * pending confirmation per contact) any earlier one that was never resolved. */
  request(input: { contactId: string; toolName: string; args: unknown; summary: string }): Promise<PendingConfirmation>;
  /** The contact's current pending confirmation, or `undefined` if there is none, it already got
   * resolved (confirmed/canceled), or it expired — expiry is checked here, not swept separately, so
   * a caller never has to reason about a stale-but-still-present row. */
  getPending(contactId: string): Promise<PendingConfirmation | undefined>;
  /** Marks `contactId`'s pending confirmation resolved (confirmed or canceled) so it can never be
   * acted on again — a repeated "confirm" delivery after this is a clean no-op via `getPending()`. */
  resolve(contactId: string): Promise<void>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pending_confirmations (
  contactId TEXT PRIMARY KEY,
  id TEXT NOT NULL,
  toolName TEXT NOT NULL,
  args TEXT NOT NULL,
  summary TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL
);
`;

const DEFAULT_TTL_MS = 5 * 60 * 1000;

interface PendingRow {
  id: string;
  toolName: string;
  args: string;
  summary: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * LibSQL-backed confirm-before-write flow (§8/§9 T8.5): a write tool's execution is held pending
 * (buttons "Confirm"/"Cancel") rather than run immediately. Deliberately its OWN small table, not
 * piggybacked onto the conversational `Memory` turn log ("persisted in Memory" per the milestone
 * brief is read here as "persisted durably, local-first" — §11 — not literally through the `Memory`
 * port): a pending confirmation isn't a conversation turn, and `Memory.load()`'s result flows
 * straight into `history-window.ts`'s summarization and `model.ts`'s prompt assembly — a no-text
 * control-flow row sitting in that same list would get summarized as `"system: (no text)"` and
 * skew `maxRecentTurns` counting, for no benefit. `contactId` as the primary key means at most one
 * pending confirmation per contact — a new `request()` naturally replaces an old unresolved one.
 */
export function createConfirmFlow(opts: ConfirmFlowOptions): ConfirmFlow {
  const client = opts.client;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const idGenerator = opts.idGenerator ?? (() => `confirm_${opts.clock.now()}_${Math.random().toString(36).slice(2)}`);

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
    async request({ contactId, toolName, args, summary }) {
      await ensureSchema();
      const now = opts.clock.now();
      const pending: PendingConfirmation = { id: idGenerator(), toolName, args, summary, createdAt: now, expiresAt: now + ttlMs };
      await client.execute({
        sql: "INSERT INTO pending_confirmations (contactId, id, toolName, args, summary, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(contactId) DO UPDATE SET id=excluded.id, toolName=excluded.toolName, args=excluded.args, summary=excluded.summary, createdAt=excluded.createdAt, expiresAt=excluded.expiresAt",
        args: [contactId, pending.id, pending.toolName, JSON.stringify(pending.args), pending.summary, pending.createdAt, pending.expiresAt],
      });
      return pending;
    },

    async getPending(contactId) {
      await ensureSchema();
      const result = await client.execute({ sql: "SELECT id, toolName, args, summary, createdAt, expiresAt FROM pending_confirmations WHERE contactId = ?", args: [contactId] });
      const row = result.rows[0] as unknown as PendingRow | undefined;
      if (!row) return undefined;
      if (row.expiresAt <= opts.clock.now()) return undefined; // expired — treated as gone, never auto-acted-on
      return { id: row.id, toolName: row.toolName, args: JSON.parse(row.args) as unknown, summary: row.summary, createdAt: row.createdAt, expiresAt: row.expiresAt };
    },

    async resolve(contactId) {
      await ensureSchema();
      await client.execute({ sql: "DELETE FROM pending_confirmations WHERE contactId = ?", args: [contactId] });
    },
  };
}
