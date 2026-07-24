import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyAnswer, DEFAULT_ANSWERS, type CompleteInterviewAnswers, type InterviewAnswers } from "./interview.js";
import { runCli, type CliDeps } from "./cli.js";

const VERSIONS = { core: "0.1.0", harness: "0.1.0", whatsapp: "0.1.0", createWappy: "0.1.0" };

function golden(): CompleteInterviewAnswers {
  let answers: InterviewAnswers = {};
  for (const [step, value] of Object.entries(DEFAULT_ANSWERS)) {
    const r = applyAnswer(answers, step as keyof InterviewAnswers, value);
    if (r.ok) answers = r.answers;
  }
  return answers as CompleteInterviewAnswers;
}

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "create-wappy-cli-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function fakeDeps(overrides: Partial<CliDeps> = {}): CliDeps {
  const lines: string[] = [];
  return {
    argv: [],
    cwd: tmpDir(),
    versions: VERSIONS,
    runInteractive: async () => golden(),
    print: (line) => lines.push(line),
    ...overrides,
  };
}

describe("runCli — non-interactive mode (any interview-step flag present)", () => {
  test("a complete, valid flag set generates the project without ever calling runInteractive", async () => {
    let interactiveCalled = false;
    const cwd = tmpDir();
    const result = await runCli({
      argv: ["--yes", "--model", "openai"],
      cwd,
      versions: VERSIONS,
      runInteractive: async () => {
        interactiveCalled = true;
        return golden();
      },
      print: () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(interactiveCalled).toBe(false);
    expect(readFileSync(join(cwd, "index.ts"), "utf8")).toContain("createAgent");
  });

  test("an invalid/incomplete flag set exits 1 WITHOUT falling back to interactive mode", async () => {
    let interactiveCalled = false;
    const result = await runCli({
      argv: ["--model", "bogus"], // an invalid model value, no --yes to fall back on
      cwd: tmpDir(),
      versions: VERSIONS,
      runInteractive: async () => {
        interactiveCalled = true;
        return golden();
      },
      print: () => {},
    });
    expect(result.exitCode).toBe(1);
    expect(interactiveCalled).toBe(false);
  });

  test("prints every validation error, not just the first", async () => {
    const printed: string[] = [];
    const result = await runCli({ argv: ["--model", "nope"], cwd: tmpDir(), versions: VERSIONS, runInteractive: async () => golden(), print: (l) => printed.push(l) });
    expect(result.exitCode).toBe(1);
    expect(printed.some((l) => l.includes("--model must be one of"))).toBe(true);
  });
});

describe("runCli — interactive mode (zero interview-step flags)", () => {
  test("no flags at all calls runInteractive and generates the resulting project", async () => {
    let interactiveCalled = false;
    const cwd = tmpDir();
    const result = await runCli({
      argv: [],
      cwd,
      versions: VERSIONS,
      runInteractive: async () => {
        interactiveCalled = true;
        return golden();
      },
      print: () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(interactiveCalled).toBe(true);
    expect(readFileSync(join(cwd, "package.json"), "utf8")).toBeTruthy();
  });

  test("--yes alone (no step flags) still counts as zero step flags -> interactive, but --yes reaches runInteractive's caller unaffected", async () => {
    // --yes with no step flags: hasAnyStepFlag is false (yes/dir/help aren't step flags), so this
    // still goes interactive — runInteractive itself decides what to do with a bare --yes.
    let interactiveCalled = false;
    await runCli({ argv: ["--yes"], cwd: tmpDir(), versions: VERSIONS, runInteractive: async () => { interactiveCalled = true; return golden(); }, print: () => {} });
    expect(interactiveCalled).toBe(true);
  });

  test("a thrown error from runInteractive (e.g. user cancelled) exits 1 with a message, not a crash", async () => {
    const printed: string[] = [];
    const result = await runCli({ argv: [], cwd: tmpDir(), versions: VERSIONS, runInteractive: async () => { throw new Error("cancelled"); }, print: (l) => printed.push(l) });
    expect(result.exitCode).toBe(1);
    expect(printed.some((l) => l.includes("cancelled"))).toBe(true);
  });

  test("a non-Error thrown by runInteractive is still stringified into a message, not a crash", async () => {
    const printed: string[] = [];
    const result = await runCli({ argv: [], cwd: tmpDir(), versions: VERSIONS, runInteractive: async () => { throw "just a string"; }, print: (l) => printed.push(l) });
    expect(result.exitCode).toBe(1);
    expect(printed.some((l) => l.includes("just a string"))).toBe(true);
  });
});

describe("runCli — --help", () => {
  test("prints help and exits 0 without touching the filesystem or calling runInteractive", async () => {
    let interactiveCalled = false;
    const printed: string[] = [];
    const result = await runCli({ argv: ["--help"], cwd: tmpDir(), versions: VERSIONS, runInteractive: async () => { interactiveCalled = true; return golden(); }, print: (l) => printed.push(l) });
    expect(result.exitCode).toBe(0);
    expect(interactiveCalled).toBe(false);
    expect(printed.join("\n")).toContain("create-wappy");
  });
});

describe("runCli — bad argv", () => {
  test("an unrecognized flag exits 1 with a clear message, before any interview logic runs", async () => {
    const printed: string[] = [];
    const result = await runCli(fakeDeps({ argv: ["--nope", "x"], print: (l) => printed.push(l) }));
    expect(result.exitCode).toBe(1);
    expect(printed[0]).toMatch(/Unrecognized flag/);
  });
});

describe("runCli — resume summary mentions skipped (already-done) files", () => {
  test("re-running against a project that already has some files generated reports both written and skipped counts", async () => {
    const cwd = tmpDir();
    const argv = ["--yes", "--model", "openai"];
    await runCli({ argv, cwd, versions: VERSIONS, runInteractive: async () => golden(), print: () => {} });

    const printed: string[] = [];
    const result = await runCli({ argv, cwd, versions: VERSIONS, runInteractive: async () => golden(), print: (l) => printed.push(l) });
    expect(result.exitCode).toBe(0);
    expect(printed.some((l) => l.includes("already up to date"))).toBe(true);
  });
});

describe("runCli — --dir resolves the target project directory relative to cwd", () => {
  test("files are written under cwd/--dir, not cwd itself", async () => {
    const cwd = tmpDir();
    const result = await runCli({
      argv: ["--yes", "--model", "openai", "--dir", "my-bot"],
      cwd,
      versions: VERSIONS,
      runInteractive: async () => golden(),
      print: () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(cwd, "my-bot", "index.ts"), "utf8")).toContain("createAgent");
  });
});

describe("runCli — a corrupt existing state.json surfaces a clear error, not a crash", () => {
  test("StateLoadError from generateProject is caught and reported, exit code 1", async () => {
    const cwd = tmpDir();
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(cwd, ".wappy"), { recursive: true });
    writeFileSync(join(cwd, ".wappy/state.json"), "{not valid json");

    const printed: string[] = [];
    const result = await runCli({
      argv: ["--yes", "--model", "openai"],
      cwd,
      versions: VERSIONS,
      runInteractive: async () => golden(),
      print: (l) => printed.push(l),
    });
    expect(result.exitCode).toBe(1);
    expect(printed.some((l) => l.includes("corrupt"))).toBe(true);
  });
});
