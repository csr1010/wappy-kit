import { describe, expect, test } from "vitest";
import { DEFAULT_ANSWERS, renderProject } from "./index.js";

const VERSIONS = { core: "0.2.0", harness: "0.2.0", whatsapp: "0.2.0", productivity: "0.3.1", connectorGoogle: "0.3.1", connectorCognee: "0.1.1", createWappy: "0.4.3" };
const indexFor = (backend: "local" | "cognee") =>
  renderProject({ answers: { model: DEFAULT_ANSWERS.model, memory: { backend }, productivity: { enabled: false } }, versions: VERSIONS }).find((f) => f.path === "index.ts")!.content;

describe("M16: generated index.ts imports only what it uses", () => {
  test("a Cognee project doesn't import createKnowledge (found by B7's lint over the frozen snapshot)", () => {
    expect(indexFor("cognee")).not.toMatch(/\bcreateKnowledge\b(?!Rag)/);
  });
  test("a local-memory project still imports and uses it", () => {
    const src = indexFor("local");
    expect(src).toMatch(/import \{[^}]*\bcreateKnowledge,/);
    expect(src).toContain("createKnowledge({ client: knowledgeClient })");
  });
});
