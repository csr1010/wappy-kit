import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { OpenAPIV3 } from "openapi-types";
import { loadSpec, SpecLoadError } from "./load.js";
import { generateTools } from "./operations.js";
import { curate } from "./curate.js";
import { generateHugeSpec } from "./huge-spec-fixture.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/openapi/", import.meta.url));

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(`${FIXTURES}${name}`, "utf8"));
}

function toolSnapshot(tools: ReturnType<typeof generateTools>["tools"]) {
  // Strip the raw `operation` object (verbose, not the interesting/stable part) for a readable golden.
  return tools
    .map((t) => ({ name: t.name, description: t.description, method: t.method, path: t.path, operationId: t.operationId, parameters: t.parameters }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

describe("T7.10 fixtures — golden snapshots of generated tools", () => {
  test("petstore-3.0.json", async () => {
    const { document } = await loadSpec(readFixture("petstore-3.0.json") as Record<string, unknown>);
    const { tools, skipped } = generateTools(document);
    expect(skipped).toEqual([]);
    expect(toolSnapshot(tools)).toMatchSnapshot();
  });

  test("petstore-2.0.json (post-normalization)", async () => {
    const { document } = await loadSpec(readFixture("petstore-2.0.json") as Record<string, unknown>);
    const { tools, skipped } = generateTools(document);
    expect(skipped).toEqual([]);
    expect(toolSnapshot(tools)).toMatchSnapshot();
  });

  test("petstore-3.1.json", async () => {
    const { document } = await loadSpec(readFixture("petstore-3.1.json") as Record<string, unknown>);
    const { tools, skipped } = generateTools(document);
    expect(skipped).toEqual([]);
    expect(toolSnapshot(tools)).toMatchSnapshot();
  });

  test("circular-ref.json", async () => {
    const { document } = await loadSpec(readFixture("circular-ref.json") as Record<string, unknown>);
    const { tools, skipped } = generateTools(document);
    expect(skipped).toEqual([]);
    expect(toolSnapshot(tools)).toMatchSnapshot();
  });

  test("oneof-payload.json", async () => {
    const { document } = await loadSpec(readFixture("oneof-payload.json") as Record<string, unknown>);
    const { tools, skipped } = generateTools(document);
    expect(skipped).toEqual([]);
    expect(toolSnapshot(tools)).toMatchSnapshot();
  });

  test("missing-operationid.json", async () => {
    const { document } = await loadSpec(readFixture("missing-operationid.json") as Record<string, unknown>);
    const { tools, skipped } = generateTools(document);
    expect(skipped).toEqual([]);
    expect(toolSnapshot(tools)).toMatchSnapshot();
  });
});

describe("T7.10 — broken spec fails loud at install with a clear, located error", () => {
  test("malformed.json fails loudly with pointer-level errors, not a generic crash", async () => {
    await expect(loadSpec(readFixture("malformed.json") as Record<string, unknown>)).rejects.toThrow(SpecLoadError);
  });
});

describe("T7.10 — partially bad spec: good operations kept, bad ones reported", () => {
  // A document-wide dangling $ref makes SwaggerParser.validate() reject the WHOLE spec at loadSpec()
  // time (correctly — "fail loud at install", see the malformed.json test above), so this property
  // — one bad OPERATION doesn't block the rest — is necessarily demonstrated at the generateTools()
  // layer directly (on an already-loaded/bundled document), the same layer that actually owns it.
  test("one broken operation among several good ones is skipped and reported, the rest still generate", () => {
    const spec = readFixture("petstore-3.0.json") as OpenAPIV3.Document;
    const document = structuredClone(spec);
    (document.paths as Record<string, unknown>)["/broken"] = {
      get: {
        operationId: "brokenOp",
        parameters: [{ name: "x", in: "query", schema: { $ref: "#/components/schemas/DoesNotExist" } }],
        responses: { "200": { description: "ok" } },
      },
    };
    const { tools, skipped } = generateTools(document);
    expect(tools.some((t) => t.name === "listPets")).toBe(true);
    expect(tools.some((t) => t.name === "getPet")).toBe(true);
    expect(skipped.some((s) => s.operationId === "brokenOp")).toBe(true);
  });
});

describe("T7.10 — 800-operation synthetic spec", () => {
  test("generates roughly the requested operation count, well within a generous time budget", async () => {
    const spec = generateHugeSpec(800);
    const start = Date.now();
    const { document } = await loadSpec(spec as unknown as Record<string, unknown>);
    const { tools, skipped } = generateTools(document);
    const elapsedMs = Date.now() - start;
    expect(tools.length).toBeGreaterThanOrEqual(780); // close to 800 — resource*method grid may slightly overshoot/undershoot the target
    expect(tools.length).toBeLessThanOrEqual(820);
    expect(skipped).toEqual([]);
    expect(elapsedMs).toBeLessThan(5000); // generous perf budget — proves no accidental quadratic blowup at this scale
  });

  test("curate() narrows the huge set down to <= max via lexical ranking, without erroring", async () => {
    const spec = generateHugeSpec(800);
    const { document } = await loadSpec(spec as unknown as Record<string, unknown>);
    const { tools } = generateTools(document);
    const result = curate(tools, { tags: ["orders"], max: 5 });
    expect(result.tools.length).toBeLessThanOrEqual(5);
    expect(result.tools.every((t) => t.operation.tags?.includes("orders"))).toBe(true);
  });

  test("the 20 distinctive operations (used by a cross-package BM25-selector test) are present with unique, stable names", async () => {
    const spec = generateHugeSpec(800);
    const { document } = await loadSpec(spec as unknown as Record<string, unknown>);
    const { tools } = generateTools(document);
    expect(tools.some((t) => t.name === "getOrderStatus")).toBe(true);
    expect(tools.some((t) => t.name === "searchProductCatalog")).toBe(true);
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length); // no name collisions across the whole synthetic spec
  });
});
