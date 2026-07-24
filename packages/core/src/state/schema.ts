import { z } from "zod";
import { systemClock, type Clock } from "../clock.js";

/** .wappy/state.json schema v1 (SPEC §5). Bump this and add a migration (migrations.ts) to change the shape. */
export const STATE_SCHEMA_VERSION = 1;

export const StepStatusSchema = z.enum(["pending", "done", "failed"]);

export const StateStepSchema = z.object({
  id: z.string().min(1),
  /** Which part contributed this step (SetupManifest.part) — scopes plugin-only reset. */
  part: z.string().min(1),
  status: StepStatusSchema,
  error: z.string().optional(),
});
export type StateStep = z.infer<typeof StateStepSchema>;

export const StatePartSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
});
export type StatePart = z.infer<typeof StatePartSchema>;

/** Names + booleans only — an env key's actual value is never written to state (SPEC §5, §11). */
export const EnvKeyStateSchema = z.object({
  name: z.string().min(1),
  required: z.boolean(),
  filled: z.boolean(),
});
export type EnvKeyState = z.infer<typeof EnvKeyStateSchema>;

export const GeneratedFileHashSchema = z.object({
  path: z.string().min(1),
  part: z.string().min(1),
  sha256: z.string().min(1),
});
export type GeneratedFileHash = z.infer<typeof GeneratedFileHashSchema>;

export const StateSchema = z.object({
  schemaVersion: z.literal(STATE_SCHEMA_VERSION),
  runId: z.string().min(1),
  parts: z.array(StatePartSchema),
  steps: z.array(StateStepSchema),
  envKeys: z.array(EnvKeyStateSchema),
  lastStep: z.string().nullable(),
  generatedFiles: z.array(GeneratedFileHashSchema),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type State = z.infer<typeof StateSchema>;

export function createEmptyState(runId: string, clock: Pick<Clock, "now"> = systemClock): State {
  const now = clock.now();
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    runId,
    parts: [],
    steps: [],
    envKeys: [],
    lastStep: null,
    generatedFiles: [],
    createdAt: now,
    updatedAt: now,
  };
}
