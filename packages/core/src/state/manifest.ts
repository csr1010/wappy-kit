import { aggregateSetupManifests, type SetupManifest } from "../setup-manifest.js";
import { systemClock, type Clock } from "../clock.js";
import { stepKey, type EnvKeyState, type State, type StatePart, type StateStep } from "./schema.js";

export interface AppliedManifests {
  state: State;
  /** Steps that were in state but are no longer contributed by any registered part — reported, not silently dropped. */
  removedSteps: Pick<StateStep, "id" | "part">[];
}

/**
 * Reconciles the ledger against the currently-registered parts' SetupManifests: existing step/env
 * statuses are preserved, newly-declared ones start `pending`/unfilled, and steps no longer
 * contributed by anyone are pulled out of the active list (SPEC §5 "unknown/removed steps").
 *
 * Step ids are only unique WITHIN a part (aggregateSetupManifests dedupes on `part:id`, so two
 * different parts may both declare a step called e.g. "creds") — every lookup here is keyed by
 * the `part:id` pair via stepKey(), never by `id` alone.
 */
export function applyManifests(state: State, parts: StatePart[], manifests: SetupManifest[], clock: Pick<Clock, "now"> = systemClock): AppliedManifests {
  const aggregated = aggregateSetupManifests(manifests);
  const activeKeys = new Set(aggregated.steps.map((s) => stepKey(s)));

  const existingStepByKey = new Map(state.steps.map((s) => [stepKey(s), s]));
  const steps: StateStep[] = aggregated.steps.map((s) => existingStepByKey.get(stepKey(s)) ?? { id: s.id, part: s.part, status: "pending" });
  const removedSteps = state.steps.filter((s) => !activeKeys.has(stepKey(s))).map((s) => ({ id: s.id, part: s.part }));

  const existingEnvByName = new Map(state.envKeys.map((e) => [e.name, e]));
  const envKeys: EnvKeyState[] = aggregated.envKeys.map((name) => existingEnvByName.get(name) ?? { name, required: true, filled: false });

  return {
    state: { ...state, parts: [...parts], steps, envKeys, updatedAt: clock.now() },
    removedSteps,
  };
}
