import { describe, expect, test } from "vitest";
import { DEFAULT_ANSWERS, type CompleteInterviewAnswers } from "./interview.js";
import { renderProject, type PartVersions } from "./templates.js";

/**
 * M14 fix: found by hand-testing a real `npm install` through a local registry (Verdaccio), not by
 * the unit suite — `start: "node index.js"` failed MODULE_NOT_FOUND on every real install, since no
 * build step ever produces index.js; index.ts is run directly via `wappy dev`'s dynamic import. This
 * pins the fix so it can't silently regress.
 */

const VERSIONS: PartVersions = { core: "0.1.0", harness: "0.1.0", whatsapp: "0.1.0", createWappy: "0.1.0" };

function complete(): CompleteInterviewAnswers {
  return { model: DEFAULT_ANSWERS.model, productivity: DEFAULT_ANSWERS.productivity };
}

describe("renderProject — package.json scripts", () => {
  test("start never points at a file this generator doesn't produce", () => {
    const files = renderProject({ answers: complete(), versions: VERSIONS });
    const pkg = JSON.parse(files.find((f) => f.path === "package.json")!.content) as { scripts: Record<string, string> };
    expect(pkg.scripts.start).not.toContain("index.js");
    expect(pkg.scripts.start).toBe(pkg.scripts.dev);
  });
});
