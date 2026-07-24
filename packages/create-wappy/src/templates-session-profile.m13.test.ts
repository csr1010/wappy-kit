import { describe, expect, test } from "vitest";
import { DEFAULT_ANSWERS, type CompleteInterviewAnswers, type InterviewAnswers } from "./interview.js";
import { renderProject, type PartVersions } from "./templates.js";

const VERSIONS: PartVersions = { core: "0.1.0", harness: "0.1.0", whatsapp: "0.1.0", createWappy: "0.1.0" };

function complete(overrides: Partial<InterviewAnswers> = {}): CompleteInterviewAnswers {
  return { model: overrides.model ?? DEFAULT_ANSWERS.model };
}

function fileMap(files: { path: string; content: string }[]): Map<string, string> {
  return new Map(files.map((f) => [f.path, f.content]));
}

/**
 * M13 follow-on: the session profile is default-on for every generated project, same posture as
 * Memory itself — no interview question, no opt-in flag, works identically regardless of which
 * model was chosen. (The "tools" step's Shopify combo this file used to also check was removed
 * along with the step itself — domain connectors are out of scope for this repo now — `--allow-
 * test-change`, SPEC.md decisions log.)
 */
describe("renderProject — session profile is default-on, every combo", () => {
  test.each([
    ["openai (default)", complete()],
    ["ollama", complete({ model: { provider: "ollama" } })],
  ] as const)("%s: index.ts wires createLibsqlSessionProfileStore and passes it to createAgent", (_label, answers) => {
    const files = fileMap(renderProject({ answers, versions: VERSIONS }));
    const indexTs = files.get("index.ts")!;
    expect(indexTs).toContain('import { createInMemoryTracer, systemClock } from "@wappy/core";');
    expect(indexTs).toContain("createLibsqlSessionProfileStore");
    expect(indexTs).toContain('const sessionProfileStore = createLibsqlSessionProfileStore({ url: process.env.SESSION_PROFILE_DB_URL ?? "file:.wappy/session-profile.db" });');
    expect(indexTs).toContain("  sessionProfileStore,");
  });

  test("SESSION_PROFILE_DB_URL is always listed in .env.sample, optional (commented out)", () => {
    const files = fileMap(renderProject({ answers: complete(), versions: VERSIONS }));
    const env = files.get(".env.sample")!;
    expect(env).toContain("\n# SESSION_PROFILE_DB_URL=\n");
    expect(env).not.toContain("\nSESSION_PROFILE_DB_URL=");
  });

  test("no new package.json dependency: createLibsqlSessionProfileStore is already part of @wappy/harness", () => {
    const files = fileMap(renderProject({ answers: complete(), versions: VERSIONS }));
    const pkg = JSON.parse(files.get("package.json")!);
    expect(pkg.dependencies["@wappy/harness"]).toBe("0.1.0");
    expect(pkg.dependencies["@libsql/client"]).toBeUndefined();
  });
});
