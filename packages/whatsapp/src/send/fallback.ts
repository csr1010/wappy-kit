import type { SmartMessage } from "@wappy/core";

export interface NumberedOption {
  number: number;
  id: string;
  title: string;
}

export interface NumberedFallback {
  text: string;
  options: NumberedOption[];
}

/** Degrades a rich message (buttons/list) to plain numbered text — the bottom rung of the fallback ladder (§6.2). */
export function renderNumberedFallback(message: SmartMessage): NumberedFallback {
  const options: NumberedOption[] = [];
  if (message.buttons) {
    message.buttons.forEach((b, i) => options.push({ number: i + 1, id: b.id, title: b.title }));
  } else if (message.list) {
    let n = 1;
    for (const section of message.list.sections) for (const row of section.rows) options.push({ number: n++, id: row.id, title: row.title });
  }

  const lines: string[] = [];
  if (message.text) lines.push(message.text);
  for (const o of options) lines.push(`${o.number}. ${o.title}`);
  if (options.length > 0) lines.push(`Reply with a number (1-${options.length}).`);
  return { text: lines.join("\n"), options };
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** Remembers which numbered options were last offered to a contact, so a later plain-text reply can be mapped back. */
export interface FallbackOptionsStore {
  record(contactId: string, options: NumberedOption[], now: number): void;
  /** Consumes (clears) the pending options on a match, so a stray later number doesn't re-match. */
  resolve(contactId: string, replyText: string, now: number): NumberedOption | undefined;
}

export function createFallbackOptionsStore(ttlMs = DEFAULT_TTL_MS): FallbackOptionsStore {
  const pending = new Map<string, { options: NumberedOption[]; expiresAt: number }>();
  return {
    record(contactId, options, now) {
      pending.set(contactId, { options, expiresAt: now + ttlMs });
    },
    resolve(contactId, replyText, now) {
      const entry = pending.get(contactId);
      if (!entry || entry.expiresAt <= now) return undefined;
      const match = /^\s*(\d+)\s*$/.exec(replyText);
      if (!match?.[1]) return undefined;
      const n = Number(match[1]);
      const option = entry.options.find((o) => o.number === n);
      if (option) pending.delete(contactId);
      return option;
    },
  };
}
