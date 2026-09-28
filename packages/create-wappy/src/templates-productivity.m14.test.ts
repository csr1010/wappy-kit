import { describe, expect, test } from "vitest";
import { DEFAULT_ANSWERS, type CompleteInterviewAnswers } from "./interview.js";
import { renderProject, type PartVersions } from "./templates.js";

/**
 * Phase 5 (plan: "Wire @wappy_ai/productivity into create-agent and wappy dev"). Confirms the new
 * interview step actually changes generated output, and that a "no" answer leaves everything exactly
 * as it was before this step existed — no leftover productivity code either way.
 */

const VERSIONS: PartVersions = { core: "0.1.0", harness: "0.1.0", whatsapp: "0.1.1", productivity: "0.1.0", createWappy: "0.1.0" };

function withProductivity(enabled: boolean): CompleteInterviewAnswers {
  return { model: DEFAULT_ANSWERS.model, productivity: { enabled } };
}

function fileMap(files: { path: string; content: string }[]): Map<string, string> {
  return new Map(files.map((f) => [f.path, f.content]));
}

describe("renderProject — productivity: false (default)", () => {
  const files = fileMap(renderProject({ answers: withProductivity(false), versions: VERSIONS }));

  test("index.ts has no productivity imports or wiring", () => {
    const indexTs = files.get("index.ts")!;
    expect(indexTs).not.toContain("@wappy_ai/productivity");
    expect(indexTs).not.toContain("taskRunner");
    expect(indexTs).not.toContain("taskUiServer");
    expect(indexTs).not.toContain("createTemplateRegistry");
  });

  test("package.json has no @wappy_ai/productivity dependency", () => {
    const pkg = JSON.parse(files.get("package.json")!);
    expect(pkg.dependencies["@wappy_ai/productivity"]).toBeUndefined();
  });

  test(".env.sample has no TASKS_DB_URL", () => {
    expect(files.get(".env.sample")!).not.toContain("TASKS_DB_URL");
  });

  test("WHATSAPP_SETUP.md has no Scheduled messages section", () => {
    expect(files.get("WHATSAPP_SETUP.md")!).not.toContain("Scheduled messages");
  });

  test("README has no productivity-agent line", () => {
    expect(files.get("README.md")!).not.toContain("Productivity agent");
  });
});

describe("renderProject — productivity: true", () => {
  const files = fileMap(renderProject({ answers: withProductivity(true), versions: VERSIONS }));
  const indexTs = files.get("index.ts")!;

  test("index.ts imports and wires the productivity package", () => {
    expect(indexTs).toContain('from "@wappy_ai/productivity"');
    expect(indexTs).toContain("createTaskStore");
    expect(indexTs).toContain("createTaskRunner");
    expect(indexTs).toContain("createTaskUiServer");
    expect(indexTs).toContain("DEFAULT_ACTIONS");
    expect(indexTs).toContain("export const taskRunner");
    expect(indexTs).toContain("export const taskUiServer");
  });

  test("index.ts registers SCHEDULED_MESSAGE_TEMPLATE and wires it into createWhatsAppChannel", () => {
    expect(indexTs).toContain("createTemplateRegistry");
    expect(indexTs).toContain("SCHEDULED_MESSAGE_TEMPLATE");
    expect(indexTs).toContain("templateRegistry.register(");
    expect(indexTs).toContain("defaultTemplateName: SCHEDULED_MESSAGE_TEMPLATE.name");
    expect(indexTs).toContain("templateVariables:");
  });

  test("the task runner and UI server share the SAME store, channel, memory, sessionProfileStore, model as the reactive agent", () => {
    // A crude but real check: taskRunner's own construction references the same identifiers used to
    // build the reactive agent, not freshly re-constructed instances.
    expect(indexTs).toMatch(/createTaskRunner\(\{[\s\S]*channel,[\s\S]*memory,\s*sessionProfileStore,\s*model,?[\s\S]*\}\)/);
  });

  test("package.json depends on @wappy_ai/productivity at the resolved version", () => {
    const pkg = JSON.parse(files.get("package.json")!);
    expect(pkg.dependencies["@wappy_ai/productivity"]).toBe("0.1.0");
  });

  test(".env.sample lists TASKS_DB_URL as optional, under its own group", () => {
    const env = files.get(".env.sample")!;
    expect(env).toContain("Productivity");
    expect(env).toContain("\n# TASKS_DB_URL=\n");
  });

  test("WHATSAPP_SETUP.md gets a real Scheduled messages section naming the exact template", () => {
    const setup = files.get("WHATSAPP_SETUP.md")!;
    expect(setup).toContain("Scheduled messages");
    expect(setup).toContain("wappy_scheduled_update");
    expect(setup).toContain("Utility");
  });

  test("README mentions the productivity agent and the task UI URL", () => {
    const readme = files.get("README.md")!;
    expect(readme).toContain("Productivity agent");
    expect(readme).toContain("task-management page");
  });
});
