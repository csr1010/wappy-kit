import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { State } from "./schema.js";

export type DriftStatus = "clean" | "modified" | "missing";

export interface DriftEntry {
  path: string;
  part: string;
  status: DriftStatus;
}

/** Compares each tracked generated file's stored hash against its current content on disk (doctor, SPEC §5). */
export function detectDrift(state: State, projectRoot: string): DriftEntry[] {
  return state.generatedFiles.map((f) => {
    const abs = join(projectRoot, f.path);
    if (!existsSync(abs)) return { path: f.path, part: f.part, status: "missing" };
    const actual = createHash("sha256").update(readFileSync(abs)).digest("hex");
    return { path: f.path, part: f.part, status: actual === f.sha256 ? "clean" : "modified" };
  });
}
