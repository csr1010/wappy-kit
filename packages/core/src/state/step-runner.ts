import { systemClock, type Clock } from "../clock.js";
import type { State, StateStep } from "./schema.js";

export interface StepDef {
  id: string;
  part: string;
  run: () => Promise<void> | void;
}

export interface StepResult {
  id: string;
  status: "done" | "failed";
  error?: string;
  /** true if the step was already `done` in state and run() was not called again. */
  skipped: boolean;
}

function upsertStep(steps: StateStep[], next: StateStep): StateStep[] {
  const i = steps.findIndex((s) => s.id === next.id);
  if (i === -1) return [...steps, next];
  const copy = [...steps];
  copy[i] = next;
  return copy;
}

/** Idempotent: a step already `done` is skipped, never re-run. Persists status either way. */
export async function runStep(state: State, def: StepDef, clock: Pick<Clock, "now"> = systemClock): Promise<{ state: State; result: StepResult }> {
  const existing = state.steps.find((s) => s.id === def.id);
  if (existing?.status === "done") {
    return { state, result: { id: def.id, status: "done", skipped: true } };
  }

  try {
    await def.run();
    const steps = upsertStep(state.steps, { id: def.id, part: def.part, status: "done" });
    return { state: { ...state, steps, lastStep: def.id, updatedAt: clock.now() }, result: { id: def.id, status: "done", skipped: false } };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    const steps = upsertStep(state.steps, { id: def.id, part: def.part, status: "failed", error });
    return { state: { ...state, steps, lastStep: def.id, updatedAt: clock.now() }, result: { id: def.id, status: "failed", error, skipped: false } };
  }
}

/** Runs steps in order, resuming from the first not-yet-done one; stops (without running later steps) on the first failure. */
export async function runSteps(state: State, defs: StepDef[], clock: Pick<Clock, "now"> = systemClock): Promise<{ state: State; results: StepResult[] }> {
  let current = state;
  const results: StepResult[] = [];
  for (const def of defs) {
    const { state: next, result } = await runStep(current, def, clock);
    current = next;
    results.push(result);
    if (result.status === "failed") break;
  }
  return { state: current, results };
}
