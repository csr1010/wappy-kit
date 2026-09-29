import { describe, expect, test } from "vitest";
import { DEFAULT_ANSWERS, type CompleteInterviewAnswers } from "./interview.js";
import { renderProject, type PartVersions } from "./templates.js";

/**
 * Phase 5 (plan: "Wire @wappy_ai/productivity into create-agent and wappy dev"), rewritten for the
 * v2 pivot (--allow-test-change "dropped cron scheduling and WhatsApp Message Templates entirely in
 * favor of a reactive task router — direct feedback: 'we should not setup cron or templates at this
 * point especially for free open source projects thats too much'"). Confirms the interview step
 * actually changes generated output, and that a "no" answer leaves everything exactly as it was
 * before this step existed — no leftover productivity code either way.
 */

const VERSIONS: PartVersions = { core: "0.1.0", harness: "0.1.0", whatsapp: "0.1.1", productivity: "0.2.0", connectorGoogle: "0.2.0", createWappy: "0.1.0" };

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
    expect(indexTs).not.toContain("taskRouter");
    expect(indexTs).not.toContain("taskUiServer");
    expect(indexTs).toContain("export const agent = createAgent(");
  });

  test("package.json has no @wappy_ai/productivity dependency", () => {
    const pkg = JSON.parse(files.get("package.json")!);
    expect(pkg.dependencies["@wappy_ai/productivity"]).toBeUndefined();
  });

  test(".env.sample has no TASKS_DB_URL", () => {
    expect(files.get(".env.sample")!).not.toContain("TASKS_DB_URL");
  });

  test("WHATSAPP_SETUP.md has no productivity-agent section", () => {
    expect(files.get("WHATSAPP_SETUP.md")!).not.toContain("productivity agent");
  });

  test("README has no productivity-agent line", () => {
    expect(files.get("README.md")!).not.toContain("Productivity agent");
  });

  test("no GOOGLE_SETUP.md is generated at all", () => {
    expect(files.has("GOOGLE_SETUP.md")).toBe(false);
  });

  test("index.ts has no Google wiring", () => {
    const indexTs = files.get("index.ts")!;
    expect(indexTs).not.toContain("@wappy_ai/connector-google");
    expect(indexTs).not.toContain("googlePlugin");
  });
});

describe("renderProject — productivity: true", () => {
  const files = fileMap(renderProject({ answers: withProductivity(true), versions: VERSIONS }));
  const indexTs = files.get("index.ts")!;

  test("index.ts imports and wires the productivity package's reactive router (no scheduler, no templates)", () => {
    expect(indexTs).toContain('from "@wappy_ai/productivity"');
    expect(indexTs).toContain("createTaskStore");
    expect(indexTs).toContain("createTaskRouter");
    expect(indexTs).toContain("createTaskUiServer");
    expect(indexTs).toContain("export const taskUiServer");
    expect(indexTs).not.toContain("createTaskRunner");
    expect(indexTs).not.toContain("taskRunner");
  });

  test("index.ts never configures a WhatsApp Message Template — every reply is a direct response", () => {
    expect(indexTs).not.toContain("createTemplateRegistry");
    expect(indexTs).not.toContain("templateRegistry");
    expect(indexTs).not.toContain("defaultTemplateName");
    expect(indexTs).not.toContain("SCHEDULED_MESSAGE_TEMPLATE");
  });

  test("index.ts wraps the reactive agent: tries the task router first, falls through to the base agent", () => {
    expect(indexTs).toContain("export const reactiveAgent = createAgent(");
    expect(indexTs).toMatch(/export const agent = \{[\s\S]*taskRouter\.maybeHandle\(message\)[\s\S]*reactiveAgent\.handle\(message\)/);
  });

  test("the task router shares the SAME model as the reactive agent, not a freshly re-constructed instance", () => {
    expect(indexTs).toMatch(/createTaskRouter\(\{\s*store: taskStore, model,/);
  });

  test("package.json depends on @wappy_ai/productivity at the resolved version", () => {
    const pkg = JSON.parse(files.get("package.json")!);
    expect(pkg.dependencies["@wappy_ai/productivity"]).toBe("0.2.0");
  });

  test(".env.sample lists TASKS_DB_URL as optional, under its own group", () => {
    const env = files.get(".env.sample")!;
    expect(env).toContain("Productivity");
    expect(env).toContain("\n# TASKS_DB_URL=\n");
  });

  test("WHATSAPP_SETUP.md explains no Message Template is ever needed here", () => {
    const setup = files.get("WHATSAPP_SETUP.md")!;
    expect(setup).toContain("do **not** need to set up a WhatsApp Message Template");
  });

  test("README mentions the productivity agent and the task UI URL", () => {
    const readme = files.get("README.md")!;
    expect(readme).toContain("Productivity agent");
    expect(readme).toContain("task-management page");
  });

  test("index.ts has no Knowledge/RAG wiring — the task router grounds replies in live fetched data instead", () => {
    expect(indexTs).not.toContain("createKnowledge");
    expect(indexTs).not.toContain("retrieveRag");
  });

  test("index.ts imports and wires @wappy_ai/connector-google's context functions into the router's connectors", () => {
    expect(indexTs).toContain('from "@wappy_ai/connector-google"');
    expect(indexTs).toContain("createGmailContextFn");
    expect(indexTs).toContain("createCalendarContextFn");
    expect(indexTs).toContain("createGoogleOAuthPlugin");
    expect(indexTs).toContain("createGoogleTokenStore");
    expect(indexTs).toMatch(/connectors:\s*\{\s*gmail:\s*createGmailContextFn\(/);
  });

  test("index.ts wires the OAuth plugin into createTaskUiServer, not left unused", () => {
    expect(indexTs).toContain("oauthConnect: googlePlugin");
  });

  test("package.json depends on @wappy_ai/connector-google, no longer needs @libsql/client directly", () => {
    const pkg = JSON.parse(files.get("package.json")!);
    expect(pkg.dependencies["@wappy_ai/connector-google"]).toBe("0.2.0");
    expect(pkg.dependencies["@libsql/client"]).toBeUndefined();
  });

  test(".env.sample lists GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET as optional, under Google", () => {
    const env = files.get(".env.sample")!;
    expect(env).toContain("Google");
    expect(env).toContain("\n# GOOGLE_CLIENT_ID=\n");
    expect(env).toContain("\n# GOOGLE_CLIENT_SECRET=\n");
  });

  test("GOOGLE_SETUP.md is generated with the exact redirect URI and connect guidance", () => {
    const setup = files.get("GOOGLE_SETUP.md")!;
    expect(setup).toBeTruthy();
    expect(setup).toContain("http://localhost:3001/google/callback");
    expect(setup).toContain("Testing");
    expect(setup).toContain("Connect Google");
  });

  test("README links to GOOGLE_SETUP.md", () => {
    expect(files.get("README.md")!).toContain("GOOGLE_SETUP.md");
  });
});
