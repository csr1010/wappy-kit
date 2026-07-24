import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  applyManifests,
  createEmptyState,
  loadState,
  runSteps,
  systemClock,
  withLock,
  writeStateAtomic,
  type Clock,
  type SetupManifest,
  type State,
  type StepDef,
  type StepResult,
} from "@wappy/core";
import type { CompleteInterviewAnswers, ReferenceSkillName } from "./interview.js";
import { collectEnvVars, renderProject, type GeneratedFile, type PartVersions, type StoreSkillDraft } from "./templates.js";

/**
 * T9.3's "ledger-driven" half: takes `renderProject()`'s pure output and actually writes it to
 * disk, one `StepDef` per generated file, through `@wappy/core`'s M2 state-ledger primitives —
 * `runSteps` (a step already `done` in `.wappy/state.json` is skipped, never re-run — §5's own
 * "every generator step is idempotent" rule, and the whole basis for "resume after Ctrl-C"),
 * `withLock` (so two concurrent runs in the same project directory can't race each other's writes),
 * `applyManifests` (reconciles this run's steps + required env keys into the ledger). `templates.ts`
 * itself never touches the filesystem — this is the one place that does.
 */

const STATE_DIR = ".wappy";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function writeGeneratedFile(projectRoot: string, file: GeneratedFile): void {
  const fullPath = join(projectRoot, file.path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, file.content);
}

export interface GenerateProjectOptions {
  answers: CompleteInterviewAnswers;
  versions: PartVersions;
  /** Absolute path to the project directory — files are written relative to this, and
   * `.wappy/state.json` + the lock file live under it too. */
  projectRoot: string;
  projectName?: string;
  storeSkillDrafts?: Partial<Record<ReferenceSkillName, StoreSkillDraft>>;
  clock?: Clock;
}

export interface GenerateProjectResult {
  state: State;
  results: StepResult[];
  files: GeneratedFile[];
}

export class StateLoadError extends Error {}

/** Builds the one `SetupManifest` `create-wappy`'s generator contributes — one step per rendered
 * file, `.env.sample`'s step carrying the full required-env-key list (the ledger schema only
 * tracks env keys as a flat required set, §5 — so per-key "optional" nuance from `EnvVarSpec` lives
 * in the richer README/.env.sample text, not the ledger itself). */
function buildManifest(files: GeneratedFile[], envVarNames: string[]): SetupManifest {
  return {
    part: "create-wappy",
    steps: files.map((f) => ({
      id: `generate:${f.path}`,
      description: `Generate ${f.path}`,
      envKeys: f.path === ".env.sample" ? envVarNames : undefined,
    })),
  };
}

/** Renders (`renderProject`) and writes a project's files under `projectRoot`, resuming correctly
 * if a previous run was interrupted. Throws `StateLoadError` if `.wappy/state.json` is corrupt or
 * was written by a newer `@wappy/core` — callers (the CLI) should catch this and point the user at
 * `wappy reset` rather than let generation proceed on untrustworthy state. */
export async function generateProject(opts: GenerateProjectOptions): Promise<GenerateProjectResult> {
  const clock = opts.clock ?? systemClock;
  const stateDir = join(opts.projectRoot, STATE_DIR);
  const statePath = join(stateDir, "state.json");
  const lockPath = join(stateDir, ".lock");
  // withLock's tryAcquireLock opens the lock file with "wx" — it doesn't create parent directories.
  mkdirSync(stateDir, { recursive: true });

  return withLock(
    lockPath,
    async () => {
      const loaded = loadState(statePath);
      if (!loaded.ok) {
        if ("corrupt" in loaded) throw new StateLoadError(`${statePath}: state is corrupt (${loaded.reason}) — run "wappy reset" to start over.`);
        throw new StateLoadError(`${statePath}: state was written by a newer @wappy/core (schemaVersion ${loaded.foundVersion} > ${loaded.supportedVersion}) — run "wappy reset" to start over.`);
      }

      const files = renderProject({ answers: opts.answers, versions: opts.versions, projectName: opts.projectName, storeSkillDrafts: opts.storeSkillDrafts });
      const envVarNames = collectEnvVars({ answers: opts.answers, versions: opts.versions }).map((v) => v.name);
      const manifest = buildManifest(files, envVarNames);

      const base = loaded.state ?? createEmptyState(randomUUID(), clock);
      const { state: reconciled } = applyManifests(base, [{ name: "create-wappy", version: opts.versions.core }], [manifest], clock);

      const defs: StepDef[] = files.map((f) => ({ id: `generate:${f.path}`, part: "create-wappy", run: () => writeGeneratedFile(opts.projectRoot, f) }));
      const { state: afterSteps, results } = await runSteps(reconciled, defs, clock);

      // Recorded for every rendered file regardless of skip/done status — a resumed run's
      // untouched-on-disk files still need a current hash so `wappy doctor`'s drift detection has
      // something correct to compare against.
      const generatedFiles = files.map((f) => ({ path: f.path, part: "create-wappy", sha256: sha256(f.content) }));
      const finalState: State = { ...afterSteps, generatedFiles, updatedAt: clock.now() };
      writeStateAtomic(statePath, finalState);

      return { state: finalState, results, files };
    },
    {},
    clock,
  );
}
