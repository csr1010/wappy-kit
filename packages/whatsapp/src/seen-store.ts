/**
 * Dedupe port (§6.2 "idempotency: dedupe on message.id, Meta retries deliveries"). `createMemorySeenStore`
 * is the v0.1 impl; a persistent (LibSQL) impl is deferred until a real libsql dependency exists
 * in the workspace (Memory backends land in M5/M10) — the port is what matters for pluggability now.
 */
export interface SeenStore {
  /**
   * Atomic check-and-set: true the FIRST time an id is seen (caller should process it), false on
   * every repeat within the TTL (caller should skip it — Meta retries the same delivery).
   */
  checkAndSet(id: string, now: number): Promise<boolean>;
}

export interface MemorySeenStoreOptions {
  ttlMs?: number;
}

export function createMemorySeenStore(opts: MemorySeenStoreOptions = {}): SeenStore {
  const ttlMs = opts.ttlMs ?? 24 * 60 * 60 * 1000;
  const expiresAt = new Map<string, number>();

  return {
    // No `await` between the read and the write below, so this is atomic even under concurrent
    // callers racing on the same event-loop turn — exactly one of them observes `true`.
    async checkAndSet(id, now) {
      const existing = expiresAt.get(id);
      if (existing !== undefined && existing > now) return false;
      expiresAt.set(id, now + ttlMs);
      return true;
    },
  };
}
