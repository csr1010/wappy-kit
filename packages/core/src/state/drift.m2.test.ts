import { afterEach, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmptyState } from "./schema.js";
import { detectDrift } from "./drift.js";

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "wappy-core-state-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

describe("detectDrift", () => {
  test("unchanged file -> clean", () => {
    const root = tmpDir();
    writeFileSync(join(root, "index.ts"), "hello");
    const state = { ...createEmptyState("r1"), generatedFiles: [{ path: "index.ts", part: "harness", sha256: sha256("hello") }] };
    expect(detectDrift(state, root)).toEqual([{ path: "index.ts", part: "harness", status: "clean" }]);
  });

  test("edited file -> modified", () => {
    const root = tmpDir();
    writeFileSync(join(root, "index.ts"), "changed by hand");
    const state = { ...createEmptyState("r1"), generatedFiles: [{ path: "index.ts", part: "harness", sha256: sha256("hello") }] };
    expect(detectDrift(state, root)).toEqual([{ path: "index.ts", part: "harness", status: "modified" }]);
  });

  test("deleted file -> missing", () => {
    const root = tmpDir();
    const state = { ...createEmptyState("r1"), generatedFiles: [{ path: "index.ts", part: "harness", sha256: sha256("hello") }] };
    expect(detectDrift(state, root)).toEqual([{ path: "index.ts", part: "harness", status: "missing" }]);
  });

  test("no tracked files -> empty", () => {
    expect(detectDrift(createEmptyState("r1"), tmpDir())).toEqual([]);
  });
});
