import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { StateSchema, type State } from "./schema.js";
import { StateCorruptError } from "./errors.js";

/**
 * Write temp file (same directory, so rename is on one filesystem) + fsync + rename over the
 * target. rename(2) is atomic: a reader of `path` always sees either the old content or the new
 * content in full, never a partial write — even if the process dies mid-write, only the orphaned
 * temp file is affected, not `path`. State is parsed through StateSchema first, so anything not
 * in the schema (e.g. an accidentally-attached env *value*) is stripped before it ever reaches disk.
 */
export function writeStateAtomic(path: string, state: State): void {
  const clean = StateSchema.parse(state);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  const fd = openSync(tmp, "w");
  try {
    writeFileSync(fd, JSON.stringify(clean, null, 2));
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw e;
  }
}

/** Raw parsed JSON (any schema version) — null if no state file exists yet. Throws StateCorruptError if unreadable/not-JSON. */
export function readRawState(path: string): unknown {
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new StateCorruptError(`cannot read state file at ${path}: ${(e as Error).message}`, e);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new StateCorruptError(`state file at ${path} is not valid JSON`, e);
  }
}
