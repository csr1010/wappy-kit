import { STATE_SCHEMA_VERSION, StateSchema, type State } from "./schema.js";
import { StateCorruptError, StateVersionTooNewError } from "./errors.js";

/** Upgrades the raw shape of schemaVersion N to schemaVersion N+1. Add one entry per future bump. */
type Migration = (raw: Record<string, unknown>) => Record<string, unknown>;
const MIGRATIONS: Record<number, Migration> = {
  // 1 -> 2 goes here whenever the schema next changes.
};

/** Validates, migrates forward to STATE_SCHEMA_VERSION, and returns a typed State. Never downgrades. */
export function migrate(raw: unknown): State {
  if (typeof raw !== "object" || raw === null || !("schemaVersion" in raw)) {
    throw new StateCorruptError("state file is missing schemaVersion");
  }
  const version = (raw as { schemaVersion: unknown }).schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new StateCorruptError(`state file has an invalid schemaVersion: ${JSON.stringify(version)}`);
  }
  if (version > STATE_SCHEMA_VERSION) {
    throw new StateVersionTooNewError(version, STATE_SCHEMA_VERSION);
  }

  let current = raw as Record<string, unknown>;
  let v = version;
  while (v < STATE_SCHEMA_VERSION) {
    const step = MIGRATIONS[v];
    if (!step) throw new StateCorruptError(`no migration registered from schemaVersion ${v} to ${v + 1}`);
    current = step(current);
    v += 1;
  }

  const parsed = StateSchema.safeParse(current);
  if (!parsed.success) {
    throw new StateCorruptError(`state file failed validation after migration: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  return parsed.data;
}
