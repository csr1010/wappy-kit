import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadSpec, SpecLoadError } from "./load.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/openapi/", import.meta.url));

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(`${FIXTURES}${name}`, "utf8"));
}

describe("loadSpec — OpenAPI 3.0 object input", () => {
  test("loads a valid OpenAPI 3.0 object as-is, no conversion", async () => {
    const spec = readFixture("petstore-3.0.json");
    const result = await loadSpec(spec);
    expect(result.originalVersion).toBe("3.0");
    expect(result.document.openapi).toMatch(/^3\.0/);
    expect(result.document.paths["/pets"].get.operationId).toBe("listPets");
  });
});

describe("loadSpec — Swagger 2.0 → OpenAPI 3.x normalization", () => {
  test("a Swagger 2.0 object is converted to OpenAPI 3.x before being returned", async () => {
    const spec = readFixture("petstore-2.0.json");
    const result = await loadSpec(spec);
    expect(result.originalVersion).toBe("2.0");
    expect(result.document.openapi).toMatch(/^3\./);
    expect(result.document.swagger).toBeUndefined();
    // Swagger 2.0's host+basePath+schemes become a servers[] entry in 3.x.
    expect(result.document.servers?.[0]?.url).toContain("api.example.com");
    expect(result.document.paths["/pets"].get.operationId).toBe("listPets");
  });

  test("converted operations keep their parameters (query param survives 2.0 -> 3.x mapping)", async () => {
    const spec = readFixture("petstore-2.0.json");
    const result = await loadSpec(spec);
    const params = result.document.paths["/pets"].get.parameters;
    expect(params.some((p: { name: string; in: string }) => p.name === "limit" && p.in === "query")).toBe(true);
  });

  test("a Swagger 2.0 spec swagger2openapi itself can't convert fails loudly as a SpecLoadError", async () => {
    const spec = {
      swagger: "2.0",
      info: { title: "x", version: "1" },
      paths: { "/x": { get: { responses: { "200": { description: "ok", schema: { $ref: "#/definitions/DoesNotExist" } } } } } },
    };
    await expect(loadSpec(spec)).rejects.toThrow(SpecLoadError);
    await expect(loadSpec(spec)).rejects.toThrow(/convert/i);
  });
});

describe("loadSpec — file loading", () => {
  test("loads a spec from a file path on disk", async () => {
    const result = await loadSpec(`${FIXTURES}petstore-3.0.json`);
    expect(result.originalVersion).toBe("3.0");
    expect(result.document.paths["/pets"].get.operationId).toBe("listPets");
  });

  test("a nonexistent file path fails loudly with a SpecLoadError, not a generic crash", async () => {
    await expect(loadSpec(`${FIXTURES}does-not-exist.json`)).rejects.toThrow(SpecLoadError);
  });
});

describe("loadSpec — validation errors with pointers", () => {
  test("a malformed spec (wrong type for a required field) fails loudly with pointer-level errors", async () => {
    const spec = readFixture("malformed.json");
    await expect(loadSpec(spec)).rejects.toThrow(SpecLoadError);
    try {
      await loadSpec(spec);
      throw new Error("must not reach here");
    } catch (e) {
      expect(e).toBeInstanceOf(SpecLoadError);
      const err = e as SpecLoadError;
      expect(err.errors.length).toBeGreaterThan(0);
      expect(err.errors.some((d) => d.pointer.includes("responses"))).toBe(true);
    }
  });

  test("a spec with neither swagger nor openapi version fields fails loudly, not silently treated as 3.x", async () => {
    await expect(loadSpec({ info: { title: "x", version: "1" }, paths: {} })).rejects.toThrow(SpecLoadError);
  });

  test("a validation failure with no ajv .details (e.g. a broken $ref) still fails loudly, with an empty (not crashing) errors array", async () => {
    const spec = readFixture("petstore-3.0.json") as Record<string, unknown>;
    const clone = structuredClone(spec);
    (clone.paths as Record<string, unknown>)["/broken"] = {
      get: { operationId: "brokenOp", parameters: [{ name: "x", in: "query", schema: { $ref: "#/components/schemas/DoesNotExist" } }], responses: { "200": { description: "ok" } } },
    };
    try {
      await loadSpec(clone);
      throw new Error("must not reach here");
    } catch (e) {
      expect(e).toBeInstanceOf(SpecLoadError);
      expect((e as SpecLoadError).errors).toEqual([]); // no ajv .details on this error shape — degrades gracefully, not a crash
    }
  });
});

describe("loadSpec — URL loading goes through the SSRF guard (T7.8)", () => {
  function jsonResponse(body: unknown): Response {
    return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(body) } as Response;
  }

  test("a spec fetched from a URL is loaded through fetchSafely, not SwaggerParser's own unguarded HTTP resolver", async () => {
    const spec = readFixture("petstore-3.0.json");
    const fetchImpl = async () => jsonResponse(spec);
    const result = await loadSpec("https://spec.example.com/openapi.json", { resolveHostname: async () => ["93.184.216.34"], fetchImpl });
    expect(result.document.paths["/pets"].get.operationId).toBe("listPets");
  });

  test("a spec URL that resolves to a private/internal address is rejected loudly, never fetched", async () => {
    let called = false;
    const fetchImpl = async () => {
      called = true;
      return jsonResponse({});
    };
    await expect(loadSpec("http://internal.example.com/openapi.json", { resolveHostname: async () => ["10.0.0.5"], fetchImpl })).rejects.toThrow(SpecLoadError);
    expect(called).toBe(false);
  });

  test("allowPrivateNetworks can be explicitly passed through for a local dev spec server", async () => {
    const spec = readFixture("petstore-3.0.json");
    const fetchImpl = async () => jsonResponse(spec);
    const result = await loadSpec("http://127.0.0.1:4010/openapi.json", { allowPrivateNetworks: true, fetchImpl });
    expect(result.document.paths["/pets"].get.operationId).toBe("listPets");
  });

  test("a non-OK HTTP response fetching the spec URL fails loudly with the status code", async () => {
    const fetchImpl = async () => ({ ok: false, status: 404, headers: new Headers(), text: async () => "not found" }) as Response;
    await expect(loadSpec("https://spec.example.com/missing.json", { resolveHostname: async () => ["93.184.216.34"], fetchImpl })).rejects.toThrow(/404/);
  });

  test("a spec URL serving YAML (not JSON) is parsed correctly", async () => {
    const yaml = [
      "openapi: 3.0.3",
      "info:",
      "  title: x",
      "  version: '1'",
      "paths:",
      "  /pets:",
      "    get:",
      "      operationId: listPets",
      "      responses:",
      "        '200':",
      "          description: ok",
    ].join("\n");
    const fetchImpl = async () => ({ ok: true, status: 200, headers: new Headers(), text: async () => yaml }) as Response;
    const result = await loadSpec("https://spec.example.com/openapi.yaml", { resolveHostname: async () => ["93.184.216.34"], fetchImpl });
    expect(result.document.paths["/pets"].get.operationId).toBe("listPets");
  });
});

describe("loadSpec — $ref bundling", () => {
  test("internal $refs to components/schemas are preserved (bundle, not fully dereferenced) so T7.3 controls flattening depth", async () => {
    const spec = readFixture("petstore-3.0.json");
    const result = await loadSpec(spec);
    // Pet is referenced from two places (listPets response, getPet response); bundle() keeps $ref
    // pointers rather than replacing both with the SAME live object (which .dereference() would do).
    const serialized = JSON.stringify(result.document);
    expect(serialized).toContain("#/components/schemas/Pet");
  });
});
