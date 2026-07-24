import { systemClock, type Clock } from "../clock.js";
import { createEmptyState, type State } from "./schema.js";

export type ResetScope = { kind: "all" } | { kind: "plugin"; name: string };

export interface ResetResult {
  state: State;
  /** Paths the caller (fs-touching layer, not core) should actually delete. */
  filesToRemove: string[];
}

/** Never touches the filesystem itself — returns the paths to remove and the resulting state; the caller applies both. */
export function reset(state: State, scope: ResetScope, clock: Pick<Clock, "now"> = systemClock): ResetResult {
  if (scope.kind === "all") {
    return { state: createEmptyState(state.runId, clock), filesToRemove: state.generatedFiles.map((f) => f.path) };
  }

  const { name } = scope;
  return {
    state: {
      ...state,
      parts: state.parts.filter((p) => p.name !== name),
      steps: state.steps.filter((s) => s.part !== name),
      generatedFiles: state.generatedFiles.filter((f) => f.part !== name),
      updatedAt: clock.now(),
    },
    filesToRemove: state.generatedFiles.filter((f) => f.part === name).map((f) => f.path),
  };
}
