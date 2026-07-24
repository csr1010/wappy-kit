import { STATE_SCHEMA_VERSION, StateSchema, type State } from "./schema.js";
import { StateCorruptError, StateVersionTooNewError } from "./errors.js";

/**
 * Validates and returns a typed State. Never downgrades: a schemaVersion newer than this build
 * supports is refused (StateVersionTooNewError), not silently reinterpreted.
 *
 * v1 is the only schema version so far, so there is nothing to migrate FROM yet. When v2 lands,
 * this becomes a chain: walk `raw` through one pure transform per version (1->2, 2->3, ...) up to
 * STATE_SCHEMA_VERSION before the final StateSchema.safeParse below — add fixtures/state/v2.json
 * alongside it so migrations.m2.test.ts's fixture loop covers the new step forever.
 */
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

  const parsed = StateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new StateCorruptError(`state file failed validation: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  return parsed.data;
}
