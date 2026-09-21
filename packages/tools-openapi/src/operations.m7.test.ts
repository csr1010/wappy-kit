import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { OpenAPIV3 } from "openapi-types";
import { generateTools } from "./operations.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/openapi/", import.meta.url));

function readFixture(name: string): OpenAPIV3.Document {
  return JSON.parse(readFileSync(`${FIXTURES}${name}`, "utf8")) as OpenAPIV3.Document;
}

function doc(overrides: Partial<OpenAPIV3.Document> = {}): OpenAPIV3.Document {
  return { openapi: "3.0.3", info: { title: "x", version: "1" }, paths: {}, ...overrides } as OpenAPIV3.Document;
}

describe("generateTools — name derivation", () => {
  test("uses operationId as the tool name when present", () => {
    const { tools } = generateTools(readFixture("petstore-3.0.json"));
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["listPets", "createPet", "getPet", "deletePet"]));
  });

  test("derives a name from method+path when operationId is missing", () => {
    const spec = doc({ paths: { "/widgets/{id}": { get: { responses: { 200: { description: "ok" } } } } } });
    const { tools } = generateTools(spec);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toMatch(/^get_widgets_id$/);
  });

  test("sanitizes an operationId with characters outside [a-zA-Z0-9_-]", () => {
    const spec = doc({ paths: { "/x": { get: { operationId: "list pets!! (v2)", responses: { 200: { description: "ok" } } } } } });
    const { tools } = generateTools(spec);
    expect(tools[0]?.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  test("truncates an overlong operationId to 64 chars", () => {
    const longId = "x".repeat(200);
    const spec = doc({ paths: { "/x": { get: { operationId: longId, responses: { 200: { description: "ok" } } } } } });
    const { tools } = generateTools(spec);
    expect(tools[0]?.name.length).toBeLessThanOrEqual(64);
  });

  test("collision-safe: two operations that sanitize/derive to the same name get distinct names", () => {
    const spec = doc({
      paths: {
        "/x": { get: { operationId: "do it!", responses: { 200: { description: "ok" } } } },
        "/y": { get: { operationId: "do it?", responses: { 200: { description: "ok" } } } },
      },
    });
    const { tools } = generateTools(spec);
    expect(tools).toHaveLength(2);
    expect(tools[0]?.name).not.toBe(tools[1]?.name);
    for (const t of tools) expect(t.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  test("every generated tool name matches the required pattern, across the petstore fixture", () => {
    const { tools } = generateTools(readFixture("petstore-3.0.json"));
    for (const t of tools) expect(t.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });
});

describe("generateTools — description", () => {
  test("prefers summary over description", () => {
    const spec = doc({ paths: { "/x": { get: { operationId: "op", summary: "short", description: "long version", responses: { 200: { description: "ok" } } } } } });
    const { tools } = generateTools(spec);
    expect(tools[0]?.description).toBe("short");
  });

  test("falls back to description when summary is absent", () => {
    const spec = doc({ paths: { "/x": { get: { operationId: "op", description: "the description", responses: { 200: { description: "ok" } } } } } });
    const { tools } = generateTools(spec);
    expect(tools[0]?.description).toBe("the description");
  });

  test("bounds an overlong description", () => {
    const spec = doc({ paths: { "/x": { get: { operationId: "op", summary: "y".repeat(2000), responses: { 200: { description: "ok" } } } } } });
    const { tools } = generateTools(spec);
    expect(tools[0]?.description.length).toBeLessThanOrEqual(500);
  });

  test("never produces an empty description", () => {
    const spec = doc({ paths: { "/x": { get: { operationId: "op", responses: { 200: { description: "ok" } } } } } });
    const { tools } = generateTools(spec);
    expect(tools[0]?.description.length).toBeGreaterThan(0);
  });
});

describe("generateTools — parameter flattening with location metadata", () => {
  test("path and query parameters are flattened into one object schema with x-wappy-in metadata", () => {
    const { tools } = generateTools(readFixture("petstore-3.0.json"));
    const getPet = tools.find((t) => t.name === "getPet")!;
    expect(getPet.parameters.type).toBe("object");
    const props = getPet.parameters.properties as Record<string, Record<string, unknown>>;
    expect(props.petId).toMatchObject({ type: "string", "x-wappy-in": "path" });
    expect(getPet.parameters.required).toEqual(["petId"]);

    const listPets = tools.find((t) => t.name === "listPets")!;
    const listProps = listPets.parameters.properties as Record<string, Record<string, unknown>>;
    expect(listProps.limit).toMatchObject({ type: "integer", "x-wappy-in": "query" });
  });

  test("a request body is flattened under a 'body' property tagged x-wappy-in: body", () => {
    const { tools } = generateTools(readFixture("petstore-3.0.json"));
    const createPet = tools.find((t) => t.name === "createPet")!;
    const props = createPet.parameters.properties as Record<string, Record<string, unknown>>;
    expect(props.body).toBeDefined();
    expect(props.body["x-wappy-in"]).toBe("body");
    expect(props.body.type).toBe("object");
    expect((props.body.properties as Record<string, unknown>).name).toEqual({ type: "string" });
    expect(createPet.parameters.required).toContain("body");
  });

  test("a header parameter is tagged x-wappy-in: header", () => {
    const spec = doc({
      paths: {
        "/x": {
          get: { operationId: "op", parameters: [{ name: "X-Api-Key", in: "header", required: true, schema: { type: "string" } }], responses: { 200: { description: "ok" } } },
        },
      },
    });
    const { tools } = generateTools(spec);
    const props = tools[0]!.parameters.properties as Record<string, Record<string, unknown>>;
    expect(props["X-Api-Key"]).toMatchObject({ type: "string", "x-wappy-in": "header" });
  });

  test("path-item-level parameters are inherited by every operation under that path", () => {
    const spec = doc({
      paths: {
        "/x/{id}": {
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          get: { operationId: "getX", responses: { 200: { description: "ok" } } },
          delete: { operationId: "deleteX", responses: { 204: { description: "ok" } } },
        },
      },
    });
    const { tools } = generateTools(spec);
    for (const t of tools) {
      const props = t.parameters.properties as Record<string, Record<string, unknown>>;
      expect(props.id).toMatchObject({ "x-wappy-in": "path" });
    }
  });

  test("an operation-level parameter with the same name+in overrides the path-item-level one", () => {
    const spec = doc({
      paths: {
        "/x/{id}": {
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          get: {
            operationId: "getX",
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" }, description: "overridden" }],
            responses: { 200: { description: "ok" } },
          },
        },
      },
    });
    const { tools } = generateTools(spec);
    const props = tools[0]!.parameters.properties as Record<string, Record<string, unknown>>;
    expect(props.id?.description).toBe("overridden");
  });
});

describe("generateTools — unmappable operations are skipped, not emitted broken", () => {
  test("a broken $ref in a parameter schema causes that operation to be skipped and reported", () => {
    const spec = doc({
      paths: {
        "/x": {
          get: {
            operationId: "broken",
            parameters: [{ name: "id", in: "query", schema: { $ref: "#/components/schemas/DoesNotExist" } }],
            responses: { 200: { description: "ok" } },
          },
        },
      },
    });
    const { tools, skipped } = generateTools(spec);
    expect(tools).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ method: "get", path: "/x", operationId: "broken" });
    expect(skipped[0]?.reason).toBeTruthy();
  });

  test("one bad operation doesn't prevent good operations in the same spec from being generated", () => {
    const spec = doc({
      paths: {
        "/good": { get: { operationId: "good", responses: { 200: { description: "ok" } } } },
        "/bad": { get: { operationId: "bad", parameters: [{ name: "id", in: "query", schema: { $ref: "#/components/schemas/Nope" } }], responses: { 200: { description: "ok" } } } },
      },
    });
    const { tools, skipped } = generateTools(spec);
    expect(tools.map((t) => t.name)).toEqual(["good"]);
    expect(skipped.map((s) => s.operationId)).toEqual(["bad"]);
  });
});

describe("generateTools — non-operation path-item keys are ignored", () => {
  test("a path-item's own 'summary'/'description' fields (not HTTP methods) don't get treated as operations", () => {
    const spec = doc({ paths: { "/x": { summary: "path summary", get: { operationId: "op", responses: { 200: { description: "ok" } } } } } });
    const { tools } = generateTools(spec);
    expect(tools).toHaveLength(1);
  });
});
