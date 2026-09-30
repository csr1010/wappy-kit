import { describe, expect, test } from "vitest";
import { DEFAULT_ANSWERS, type CompleteInterviewAnswers } from "./interview.js";
import { renderProject, type PartVersions } from "./templates.js";

/**
 * Phase 5 (plan: "Wire @wappy_ai/productivity into create-agent and wappy dev"), rewritten for the
 * v3 pivot (--allow-test-change "retired the saved-task/fixed-template system entirely in favor of
 * generic, parameterized Gmail/Calendar search tools + the harness's own multi-step tool-calling
 * loop — direct feedback: 'whatever we are going to build it should work for anything that user
 * might ask'"). Confirms the interview step actually changes generated output, and that a "no"
 * answer leaves everything exactly as it was before this step existed.
 */

const VERSIONS: PartVersions = { core: "0.1.0", harness: "0.1.0", whatsapp: "0.1.1", productivity: "0.3.0", connectorGoogle: "0.3.0", createWappy: "0.1.0" };

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
    expect(indexTs).not.toContain("googleAssistant");
    expect(indexTs).not.toContain("taskUiServer");
    expect(indexTs).toContain("export const agent = createAgent(");
  });

  test("package.json has no @wappy_ai/productivity dependency", () => {
    const pkg = JSON.parse(files.get("package.json")!);
    expect(pkg.dependencies["@wappy_ai/productivity"]).toBeUndefined();
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

  test("index.ts imports and wires createGoogleAssistant — no task store, no templates", () => {
    expect(indexTs).toContain('from "@wappy_ai/productivity"');
    expect(indexTs).toContain("createGoogleAssistant");
    expect(indexTs).toContain("createConnectUiServer");
    expect(indexTs).toContain("export const taskUiServer");
    expect(indexTs).not.toContain("createTaskStore");
    expect(indexTs).not.toContain("createTaskRouter");
    expect(indexTs).not.toContain("TASK_TEMPLATES");
  });

  test("index.ts never configures a WhatsApp Message Template — every reply is a direct response", () => {
    expect(indexTs).not.toContain("createTemplateRegistry");
    expect(indexTs).not.toContain("templateRegistry");
    expect(indexTs).not.toContain("defaultTemplateName");
  });

  test("index.ts wraps the reactive agent: offers the Google assistant first, falls through to the base agent", () => {
    expect(indexTs).toContain("export const reactiveAgent = createAgent(");
    expect(indexTs).toMatch(/export const agent = \{[\s\S]*googleAssistant\.maybeHandle\(message\)[\s\S]*reactiveAgent\.handle\(message\)/);
  });

  test("the Google assistant shares the SAME model as the reactive agent, not a freshly re-constructed instance", () => {
    expect(indexTs).toMatch(/createGoogleAssistant\(\{\s*model, clock: systemClock,/);
  });

  test("index.ts wires both a parameterized Gmail and Calendar search function as the assistant's connectors", () => {
    expect(indexTs).toContain('from "@wappy_ai/connector-google"');
    expect(indexTs).toContain("createGmailSearchFn");
    expect(indexTs).toContain("createCalendarSearchFn");
    expect(indexTs).toContain("createGoogleOAuthPlugin");
    expect(indexTs).toContain("createGoogleTokenStore");
    expect(indexTs).toMatch(/connectors:\s*\{\s*gmail:\s*createGmailSearchFn\(/);
  });

  test("index.ts wires the OAuth plugin into createConnectUiServer, not left unused", () => {
    expect(indexTs).toContain("oauthConnect: googlePlugin");
  });

  test("package.json depends on @wappy_ai/productivity and @wappy_ai/connector-google at the resolved versions", () => {
    const pkg = JSON.parse(files.get("package.json")!);
    expect(pkg.dependencies["@wappy_ai/productivity"]).toBe("0.3.0");
    expect(pkg.dependencies["@wappy_ai/connector-google"]).toBe("0.3.0");
  });

  test(".env.sample has no TASKS_DB_URL (no task store exists anymore) and lists GOOGLE_CLIENT_ID/SECRET as optional", () => {
    const env = files.get(".env.sample")!;
    expect(env).not.toContain("TASKS_DB_URL");
    expect(env).toContain("Google");
    expect(env).toContain("\n# GOOGLE_CLIENT_ID=\n");
    expect(env).toContain("\n# GOOGLE_CLIENT_SECRET=\n");
  });

  test("WHATSAPP_SETUP.md explains no Message Template is ever needed here", () => {
    const setup = files.get("WHATSAPP_SETUP.md")!;
    expect(setup).toContain("do **not** need to set up a WhatsApp Message Template");
  });

  test("README mentions the productivity agent reads any question, not a fixed list", () => {
    const readme = files.get("README.md")!;
    expect(readme).toContain("Productivity agent");
    expect(readme).toContain("any question");
    expect(readme).not.toContain("task-management page");
  });

  test("index.ts has no Knowledge/RAG wiring — real fetched data grounds each reply directly", () => {
    expect(indexTs).not.toContain("createKnowledge");
    expect(indexTs).not.toContain("retrieveRag");
  });

  test("GOOGLE_SETUP.md is generated with the exact redirect URI and connect guidance, no task-authoring instructions", () => {
    const setup = files.get("GOOGLE_SETUP.md")!;
    expect(setup).toBeTruthy();
    expect(setup).toContain("http://localhost:3001/google/callback");
    expect(setup).toContain("Testing");
    expect(setup).toContain("Connect Google");
    expect(setup).not.toContain("Create a");
  });

  test("README links to GOOGLE_SETUP.md", () => {
    expect(files.get("README.md")!).toContain("GOOGLE_SETUP.md");
  });
});
