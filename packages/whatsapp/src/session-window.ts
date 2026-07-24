/** 24h customer-service-window guard (§6.2): free-form replies are only allowed within 24h of the last inbound message. */
export const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface SessionWindowTracker {
  recordInbound(contactId: string, now: number): void;
  /** false if we've never heard from this contact, or their last message was >=24h ago. */
  windowOpen(contactId: string, now: number): boolean;
}

export function createSessionWindowTracker(): SessionWindowTracker {
  const lastInboundAt = new Map<string, number>();
  return {
    recordInbound(contactId, now) {
      lastInboundAt.set(contactId, now);
    },
    windowOpen(contactId, now) {
      const last = lastInboundAt.get(contactId);
      if (last === undefined) return false;
      return now - last < SESSION_WINDOW_MS;
    },
  };
}
