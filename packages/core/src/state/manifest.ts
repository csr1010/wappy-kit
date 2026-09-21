import { aggregateSetupManifests, type SetupManifest } from "../setup-manifest.js";
import { systemClock, type Clock } from "../clock.js";
import type { EnvKeyState, State, StatePart, StateStep } from "./schema.js";

export interface AppliedManifests {
  state: State;
  /** Step ids that were in state but are no longer contributed by any registered part — reported, not silently dropped. */
  removedStepIds: string[];
}

/**
 * Reconciles the ledger against the currently-registered parts' SetupManifests: existing step/env
 * statuses are preserved, newly-declared ones start `pending`/unfilled, and steps no longer
 * contributed by anyone are pulled out of the active list (SPEC §5 "unknown/removed steps").
 */
export function applyManifests(state: State, parts: StatePart[], manifests: SetupManifest[], clock: Pick<Clock, "now"> = systemClock): AppliedManifests {
  const aggregated = aggregateSetupManifests(manifests);
  const activeIds = new Set(aggregated.steps.map((s) => s.id));

  const existingStepById = new Map(state.steps.map((s) => [s.id, s]));
  const steps: StateStep[] = aggregated.steps.map((s) => existingStepById.get(s.id) ?? { id: s.id, part: s.part, status: "pending" });
  const removedStepIds = state.steps.filter((s) => !activeIds.has(s.id)).map((s) => s.id);

  const existingEnvByName = new Map(state.envKeys.map((e) => [e.name, e]));
  const envKeys: EnvKeyState[] = aggregated.envKeys.map((name) => existingEnvByName.get(name) ?? { name, required: true, filled: false });

  return {
    state: { ...state, parts: [...parts], steps, envKeys, updatedAt: clock.now() },
    removedStepIds,
  };
}
