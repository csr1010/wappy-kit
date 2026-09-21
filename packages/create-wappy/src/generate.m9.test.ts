import { afterEach, describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyAnswer, DEFAULT_ANSWERS, type CompleteInterviewAnswers, type InterviewAnswers } from "./interview.js";
import { generateProject, StateLoadError, type GenerateProjectOptions } from "./generate.js";

const VERSIONS = { core: "0.1.0", harness: "0.1.0", whatsapp: "0.1.0", toolsOpenapi: "0.1.0" };

function complete(overrides: Partial<InterviewAnswers> = {}): CompleteInterviewAnswers {
  let answers: InterviewAnswers = {};
  for (const [step, value] of Object.entries(DEFAULT_ANSWERS)) {
    const r = applyAnswer(answers, step as keyof InterviewAnswers, (overrides as InterviewAnswers)[step as keyof InterviewAnswers] ?? value);
    if (!r.ok) throw new Error(`test setup: invalid answer for ${step}: ${r.errors.join(", ")}`);
    answers = r.answers;
  }
  return answers as CompleteInterviewAnswers;
}

const dirs: string[] = [];
function tmpProjectRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "create-wappy-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

let counter = 0;
function fakeClock() {
  return { now: () => ++counter, setTimeout: (fn: () => void) => { fn(); return 0; }, clearTimeout: () => {}, sleep: async () => {} };
}

function baseOptions(projectRoot: string): GenerateProjectOptions {
  return {
    answers: complete({ skills: { skills: ["store-info", "orders"] }, tools: { kind: "shopify", storeDomain: "luna-and-co.myshopify.com" } }),
    versions: VERSIONS,
    projectRoot,
    projectName: "luna-and-co-bot",
    clock: fakeClock(),
  };
}

describe("generateProject — defaults", () => {
  test("clock defaults to the real system clock when omitted", async () => {
    const root = tmpProjectRoot();
    const opts = baseOptions(root);
    delete opts.clock;
    const result = await generateProject(opts);
    expect(result.state.updatedAt).toBeGreaterThan(0);
  });
});

describe("generateProject — writes every rendered file to disk", () => {
  test("a fresh project directory gets index.ts, tools/, skills/, .env.example, .gitignore, package.json, README.md, and .wappy/state.json", async () => {
    const root = tmpProjectRoot();
    const result = await generateProject(baseOptions(root));

    for (const f of result.files) {
      expect(existsSync(join(root, f.path))).toBe(true);
      expect(readFileSync(join(root, f.path), "utf8")).toBe(f.content);
    }
    expect(existsSync(join(root, ".wappy/state.json"))).toBe(true);
    expect(result.results.every((r) => r.status === "done" && !r.skipped)).toBe(true);
  });

  test("state.json records one done step per file, the required env keys, and a sha256 per generated file", async () => {
    const root = tmpProjectRoot();
    const result = await generateProject(baseOptions(root));

    expect(result.state.steps.every((s) => s.status === "done" && s.part === "create-wappy")).toBe(true);
    expect(result.state.steps.map((s) => s.id)).toContain("generate:index.ts");
    expect(result.state.envKeys.map((e) => e.name)).toContain("SHOPIFY_ACCESS_TOKEN");
    const indexHash = result.state.generatedFiles.find((f) => f.path === "index.ts");
    expect(indexHash?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("generateProject — resumable / idempotent", () => {
  test("re-running with the same answers skips every already-done step (no re-write)", async () => {
    const root = tmpProjectRoot();
    const opts = baseOptions(root);
    await generateProject(opts);

    // Hand-modify a generated file to prove a second run does NOT overwrite it (steps are already `done`).
    writeFileSync(join(root, "README.md"), "HAND EDITED");

    const second = await generateProject({ ...opts, clock: opts.clock });
    expect(second.results.every((r) => r.skipped)).toBe(true);
    expect(readFileSync(join(root, "README.md"), "utf8")).toBe("HAND EDITED");
  });

  test("a run interrupted after writing some files resumes and completes only the rest", async () => {
    const root = tmpProjectRoot();
    const opts = baseOptions(root);

    // Simulate an interrupted first run: pre-seed state.json with index.ts already marked done,
    // WITHOUT actually writing index.ts to disk — mirrors a process killed between "mark done" and
    // the next step (runStep marks done immediately after run() succeeds).
    await generateProject(opts);
    rmSync(join(root, "index.ts"));
    rmSync(join(root, ".env.example"));
    const state = JSON.parse(readFileSync(join(root, ".wappy/state.json"), "utf8"));
    state.steps = state.steps.filter((s: { id: string }) => s.id !== "generate:.env.example");
    writeFileSync(join(root, ".wappy/state.json"), JSON.stringify(state));

    const resumed = await generateProject(opts);
    const envStep = resumed.results.find((r) => r.id === "generate:.env.example");
    expect(envStep?.skipped).toBe(false);
    expect(existsSync(join(root, ".env.example"))).toBe(true);
    // index.ts's step was still marked done from before, so it's skipped and NOT rewritten (stays deleted).
    const indexStep = resumed.results.find((r) => r.id === "generate:index.ts");
    expect(indexStep?.skipped).toBe(true);
    expect(existsSync(join(root, "index.ts"))).toBe(false);
  });
});

describe("generateProject — corrupt/too-new state fails loud", () => {
  test("a corrupt state.json throws StateLoadError instead of silently overwriting it", async () => {
    const root = tmpProjectRoot();
    const wappyDir = join(root, ".wappy");
    mkdirSync(wappyDir, { recursive: true });
    writeFileSync(join(wappyDir, "state.json"), "{not valid json");

    await expect(generateProject(baseOptions(root))).rejects.toThrow(StateLoadError);
  });

  test("a state.json with a too-new schemaVersion throws StateLoadError", async () => {
    const root = tmpProjectRoot();
    mkdirSync(join(root, ".wappy"), { recursive: true });
    writeFileSync(join(root, ".wappy/state.json"), JSON.stringify({ schemaVersion: 999, runId: "r1", parts: [], steps: [], envKeys: [], lastStep: null, generatedFiles: [], createdAt: 1, updatedAt: 1 }));

    await expect(generateProject(baseOptions(root))).rejects.toThrow(StateLoadError);
  });
});

describe("generateProject — concurrent runs are serialized by the lock", () => {
  test("two generateProject calls against the same project don't corrupt state.json", async () => {
    const root = tmpProjectRoot();
    const opts = baseOptions(root);
    await Promise.all([generateProject(opts), generateProject({ ...opts, clock: opts.clock })]);
    const state = JSON.parse(readFileSync(join(root, ".wappy/state.json"), "utf8"));
    expect(state.steps.filter((s: { id: string }) => s.id === "generate:index.ts")).toHaveLength(1);
  });
});
