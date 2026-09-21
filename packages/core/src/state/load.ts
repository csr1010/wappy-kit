import { readRawState } from "./io.js";
import { migrate } from "./migrations.js";
import { StateCorruptError, StateVersionTooNewError } from "./errors.js";
import type { State } from "./schema.js";

/**
 * No interactive I/O here (MILESTONES.md B: core never prompts) — a not-ok result is the "offer",
 * for a CLI/caller to present and act on (e.g. call reset()).
 */
export type LoadResult =
  | { ok: true; state: State | null } // null = no state file yet (fresh project)
  | { ok: false; corrupt: true; path: string; reason: string }
  | { ok: false; tooNew: true; path: string; foundVersion: number; supportedVersion: number };

export function loadState(path: string): LoadResult {
  let raw: unknown;
  try {
    raw = readRawState(path);
  } catch (e) {
    if (e instanceof StateCorruptError) return { ok: false, corrupt: true, path, reason: e.message };
    throw e;
  }
  if (raw === null) return { ok: true, state: null };

  try {
    return { ok: true, state: migrate(raw) };
  } catch (e) {
    if (e instanceof StateVersionTooNewError) {
      return { ok: false, tooNew: true, path, foundVersion: e.foundVersion, supportedVersion: e.supportedVersion };
    }
    if (e instanceof StateCorruptError) return { ok: false, corrupt: true, path, reason: e.message };
    throw e;
  }
}
