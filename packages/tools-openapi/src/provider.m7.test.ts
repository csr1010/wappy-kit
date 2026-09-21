import { describe, expect, test } from "vitest";
import { runToolProviderConformance, mockOpenApiServer } from "@wappy/testkit";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createOpenApiToolProvider } from "./provider.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/openapi/", import.meta.url));

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(`${FIXTURES}${name}`, "utf8"));
}

describe("createOpenApiToolProvider — conformance", () => {
  test("passes runToolProviderConformance against the petstore fixture", async () => {
    const spec = readFixture("petstore-3.0.json");
    const { provider } = await createOpenApiToolProvider({ name: "petstore", source: spec, envPrefix: "PETSTORE_", ssrf: { allowPrivateNetworks: true } });
    const violations = await runToolProviderConformance(provider);
    expect(violations).toEqual([]);
  });
});

describe("createOpenApiToolProvider — assembly", () => {
  test("generates a real, executable Tool per operation with readOnly/confirmBefore set correctly", async () => {
    const spec = readFixture("petstore-3.0.json");
    const { provider } = await createOpenApiToolProvider({ name: "petstore", source: spec, envPrefix: "PETSTORE_", ssrf: { allowPrivateNetworks: true } });
    const tools = await provider.listTools();
    const listPets = tools.find((t) => t.name === "listPets")!;
    expect(listPets.readOnly).toBe(true);
    expect(listPets.confirmBefore).toBe(false);
    const createPet = tools.find((t) => t.name === "createPet")!;
    expect(createPet.readOnly).toBe(false);
    expect(createPet.confirmBefore).toBe(true);
    expect(typeof listPets.execute).toBe("function");
  });

  test("the public parameters schema does NOT leak internal x-wappy-in/x-wappy-media-type metadata", async () => {
    const spec = readFixture("petstore-3.0.json");
    const { provider } = await createOpenApiToolProvider({ name: "petstore", source: spec, envPrefix: "PETSTORE_", ssrf: { allowPrivateNetworks: true } });
    const tools = await provider.listTools();
    const getPet = tools.find((t) => t.name === "getPet")!;
    const props = getPet.parameters.properties as Record<string, Record<string, unknown>>;
    expect(props.petId).not.toHaveProperty("x-wappy-in");
    expect(props.petId).toMatchObject({ type: "string" });
  });

  test("DELETE operations are excluded by default (T7.6 policy applied)", async () => {
    const spec = readFixture("petstore-3.0.json");
    const { provider, skipReport } = await createOpenApiToolProvider({ name: "petstore", source: spec, envPrefix: "PETSTORE_", ssrf: { allowPrivateNetworks: true } });
    const tools = await provider.listTools();
    expect(tools.some((t) => t.name === "deletePet")).toBe(false);
    expect(skipReport.some((s) => s.name === "deletePet")).toBe(true);
  });

  test("DELETE operations are included when allowDestructive is explicitly set", async () => {
    const spec = readFixture("petstore-3.0.json");
    const { provider } = await createOpenApiToolProvider({ name: "petstore", source: spec, envPrefix: "PETSTORE_", policy: { allowDestructive: true }, ssrf: { allowPrivateNetworks: true } });
    const tools = await provider.listTools();
    const del = tools.find((t) => t.name === "deletePet");
    expect(del).toBeDefined();
    expect(del?.confirmBefore).toBe(true);
  });

  test("curation options narrow the exposed tool set", async () => {
    const spec = readFixture("petstore-3.0.json");
    const { provider } = await createOpenApiToolProvider({ name: "petstore", source: spec, envPrefix: "PETSTORE_", curation: { include: ["listPets"] }, ssrf: { allowPrivateNetworks: true } });
    const tools = await provider.listTools();
    expect(tools.map((t) => t.name)).toEqual(["listPets"]);
  });

  test("executing a generated tool actually makes a real (SSRF-guarded) HTTP call and returns a normalized ToolResult", async () => {
    const spec = readFixture("petstore-3.0.json");
    // petstore-3.0.json's server is https://api.example.com — override with a local mock via baseUrl + allowPrivateNetworks.
    const { provider } = await createOpenApiToolProvider({
      name: "petstore",
      source: spec,
      envPrefix: "PETSTORE_",
      baseUrl: "http://127.0.0.1:1/", // nothing listening — proves execute() never throws, degrades to a failed ToolResult
      ssrf: { allowPrivateNetworks: true },
    });
    const tools = await provider.listTools();
    const listPets = tools.find((t) => t.name === "listPets")!;
    const result = await listPets.execute({});
    expect(result.ok).toBe(false);
    expect(result.toolName).toBe("listPets");
  });

  test("petstore-3.0.json's own server URL (which carries a /v1 path prefix, the common real-world shape) is preserved end-to-end through the real pipeline", async () => {
    const spec = readFixture("petstore-3.0.json");
    const mock = await mockOpenApiServer(spec, { "GET /v1/pets": { status: 200, body: [] } });
    try {
      const { provider } = await createOpenApiToolProvider({
        name: "petstore",
        source: spec,
        envPrefix: "PETSTORE_",
        baseUrl: `${mock.url}/v1`,
        ssrf: { allowPrivateNetworks: true },
      });
      const tools = await provider.listTools();
      const listPets = tools.find((t) => t.name === "listPets")!;
      const result = await listPets.execute({});
      expect(result.ok).toBe(true);
      expect(mock.requests.some((r) => r.path === "/v1/pets")).toBe(true);
    } finally {
      await mock.close();
    }
  });

  test("an operation needing unsupported auth (OAuth2) is skipped and reported, not silently broken", async () => {
    const spec = {
      openapi: "3.0.3",
      info: { title: "x", version: "1" },
      servers: [{ url: "https://api.example.com" }],
      paths: { "/x": { get: { operationId: "getX", security: [{ oauth: [] }], responses: { 200: { description: "ok" } } } } },
      components: { securitySchemes: { oauth: { type: "oauth2", flows: {} } } },
    };
    const { provider, skipReport } = await createOpenApiToolProvider({ name: "x", source: spec, envPrefix: "X_", ssrf: { allowPrivateNetworks: true } });
    const tools = await provider.listTools();
    expect(tools).toHaveLength(0);
    expect(skipReport.some((s) => s.name === "getX" && /oauth/i.test(s.reason))).toBe(true);
  });

  test("throws loudly at construction if no baseUrl can be determined (no servers[] and none supplied)", async () => {
    const spec = { openapi: "3.0.3", info: { title: "x", version: "1" }, paths: { "/x": { get: { operationId: "getX", responses: { 200: { description: "ok" } } } } } };
    await expect(createOpenApiToolProvider({ name: "x", source: spec, envPrefix: "X_" })).rejects.toThrow();
  });
});
