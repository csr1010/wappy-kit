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

export function createMemorySeenStore(opts: MemorySeenStoreOptions = {}): SeenStore & { size(): number } {
  const ttlMs = opts.ttlMs ?? 24 * 60 * 60 * 1000;
  const expiresAt = new Map<string, number>();

  return {
    size: () => expiresAt.size,
    // No `await` between the read/sweep and the write below, so this is atomic even under
    // concurrent callers racing on the same event-loop turn — exactly one observes `true`.
    async checkAndSet(id, now) {
      const existing = expiresAt.get(id);
      if (existing !== undefined && existing > now) return false;

      // Opportunistic sweep so this stays bounded to "unique ids within the TTL window" instead
      // of growing for the life of the process — a long-running receiver never reuses most ids
      // after their TTL, so without this the map would only ever grow.
      for (const [seenId, expiry] of expiresAt) {
        if (expiry <= now) expiresAt.delete(seenId);
      }

      expiresAt.set(id, now + ttlMs);
      return true;
    },
  };
}
