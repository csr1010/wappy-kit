import { describe, expect, test } from "vitest";
import type { OpenAPIV3 } from "openapi-types";
import { resolveSchema, SchemaUnmappableError } from "./schema.js";

function doc(schemas: Record<string, unknown>): OpenAPIV3.Document {
  return {
    openapi: "3.0.3",
    info: { title: "x", version: "1" },
    paths: {},
    components: { schemas: schemas as Record<string, OpenAPIV3.SchemaObject> },
  } as OpenAPIV3.Document;
}

describe("resolveSchema — primitives and $ref", () => {
  test("undefined schema resolves to undefined", () => {
    expect(resolveSchema(undefined, { document: doc({}) })).toBeUndefined();
  });

  test("a plain primitive schema is copied through with its scalar keywords", () => {
    const result = resolveSchema({ type: "string", format: "email", description: "an email" } as OpenAPIV3.SchemaObject, { document: doc({}) });
    expect(result).toEqual({ type: "string", format: "email", description: "an email" });
  });

  test("an enum is preserved", () => {
    const result = resolveSchema({ type: "string", enum: ["a", "b"] } as OpenAPIV3.SchemaObject, { document: doc({}) });
    expect(result?.enum).toEqual(["a", "b"]);
  });

  test("a local $ref to components/schemas resolves to the referenced schema", () => {
    const document = doc({ Pet: { type: "object", properties: { name: { type: "string" } } } });
    const result = resolveSchema({ $ref: "#/components/schemas/Pet" }, { document });
    expect(result).toEqual({ type: "object", properties: { name: { type: "string" } } });
  });

  test("a $ref with a JSON-pointer-escaped token (~1, ~0) resolves correctly", () => {
    const document = doc({ "a/b~c": { type: "string" } });
    const result = resolveSchema({ $ref: "#/components/schemas/a~1b~0c" }, { document });
    expect(result).toEqual({ type: "string" });
  });

  test("a broken $ref (doesn't resolve to anything) throws SchemaUnmappableError", () => {
    expect(() => resolveSchema({ $ref: "#/components/schemas/DoesNotExist" }, { document: doc({}) })).toThrow(SchemaUnmappableError);
  });

  test("a non-local $ref (should have been bundled already) throws SchemaUnmappableError", () => {
    expect(() => resolveSchema({ $ref: "external.json#/Pet" }, { document: doc({}) })).toThrow(SchemaUnmappableError);
  });
});

describe("resolveSchema — objects, arrays, nested properties", () => {
  test("object properties are recursively resolved and 'type' defaults to object", () => {
    const result = resolveSchema(
      { properties: { id: { type: "string" }, count: { type: "integer" } }, required: ["id"] } as OpenAPIV3.SchemaObject,
      { document: doc({}) },
    );
    expect(result).toEqual({ type: "object", properties: { id: { type: "string" }, count: { type: "integer" } }, required: ["id"] });
  });

  test("array items are recursively resolved and 'type' defaults to array", () => {
    const result = resolveSchema({ items: { type: "string" } } as OpenAPIV3.SchemaObject, { document: doc({}) });
    expect(result).toEqual({ type: "array", items: { type: "string" } });
  });

  test("a $ref nested inside object properties is resolved too", () => {
    const document = doc({ Tag: { type: "string" } });
    const result = resolveSchema({ properties: { tag: { $ref: "#/components/schemas/Tag" } } } as unknown as OpenAPIV3.SchemaObject, { document });
    expect(result?.properties).toEqual({ tag: { type: "string" } });
  });
});

describe("resolveSchema — allOf merge", () => {
  test("allOf members are merged into one object schema (properties union, required union)", () => {
    const document = doc({
      Base: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    });
    const result = resolveSchema(
      {
        allOf: [{ $ref: "#/components/schemas/Base" }, { type: "object", properties: { name: { type: "string" } }, required: ["name"] }],
      } as unknown as OpenAPIV3.SchemaObject,
      { document },
    );
    expect(result?.type).toBe("object");
    expect(result?.properties).toEqual({ id: { type: "string" }, name: { type: "string" } });
    expect(result?.required).toEqual(expect.arrayContaining(["id", "name"]));
    expect((result?.required as string[]).length).toBe(2); // deduped, not concatenated with dupes
  });

  test("a later allOf member's property overrides an earlier member's same-named property", () => {
    const result = resolveSchema(
      {
        allOf: [
          { type: "object", properties: { status: { type: "string", enum: ["a"] } } },
          { type: "object", properties: { status: { type: "string", enum: ["b"] } } },
        ],
      } as unknown as OpenAPIV3.SchemaObject,
      { document: doc({}) },
    );
    expect(result?.properties).toEqual({ status: { type: "string", enum: ["b"] } });
  });
});

describe("resolveSchema — oneOf/anyOf pass-through", () => {
  test("oneOf branches are each resolved and kept as a native JSON Schema oneOf", () => {
    const result = resolveSchema(
      { oneOf: [{ type: "string" }, { type: "integer" }] } as unknown as OpenAPIV3.SchemaObject,
      { document: doc({}) },
    );
    expect(result).toEqual({ oneOf: [{ type: "string" }, { type: "integer" }] });
  });

  test("anyOf branches are each resolved and kept as a native JSON Schema anyOf", () => {
    const result = resolveSchema(
      { anyOf: [{ type: "string" }, { $ref: "#/components/schemas/Pet" }] } as unknown as OpenAPIV3.SchemaObject,
      { document: doc({ Pet: { type: "object" } }) },
    );
    expect(result).toEqual({ anyOf: [{ type: "string" }, { type: "object" }] });
  });
});

describe("resolveSchema — circular $ref (depth-limited, not thrown)", () => {
  test("a self-referencing $ref (e.g. a tree/linked-list schema) degrades to {} at the cycle point instead of recursing forever", () => {
    const document = doc({
      Node: { type: "object", properties: { value: { type: "string" }, next: { $ref: "#/components/schemas/Node" } } },
    });
    const result = resolveSchema({ $ref: "#/components/schemas/Node" }, { document });
    expect(result?.type).toBe("object");
    expect((result?.properties as Record<string, unknown>).value).toEqual({ type: "string" });
    // The cycle is cut at "next" — degrades to {} rather than infinitely resolving Node -> next -> Node -> ...
    expect((result?.properties as Record<string, unknown>).next).toEqual({});
  });

  test("a two-hop circular reference (A -> B -> A) is also caught, not just direct self-reference", () => {
    const document = doc({
      A: { type: "object", properties: { b: { $ref: "#/components/schemas/B" } } },
      B: { type: "object", properties: { a: { $ref: "#/components/schemas/A" } } },
    });
    const result = resolveSchema({ $ref: "#/components/schemas/A" }, { document });
    const bSchema = (result?.properties as Record<string, unknown>).b as Record<string, unknown>;
    const aAgain = (bSchema.properties as Record<string, unknown>).a;
    expect(aAgain).toEqual({}); // cut before infinitely recursing back into A
  });
});

describe("resolveSchema — deep nesting cap (non-circular)", () => {
  test("a legitimately deep (but non-circular) schema is capped at maxDepth, not fully expanded", () => {
    // Build a chain of 10 distinct nested schemas — deeper than the default cap.
    const schemas: Record<string, unknown> = {};
    for (let i = 0; i < 10; i++) {
      schemas[`Level${i}`] = { type: "object", properties: { next: i + 1 < 10 ? { $ref: `#/components/schemas/Level${i + 1}` } : { type: "string" } } };
    }
    const document = doc(schemas);
    const result = resolveSchema({ $ref: "#/components/schemas/Level0" }, { document, maxDepth: 3 });
    // Walk down `next` repeatedly — should bottom out at {} well before reaching the real leaf.
    let node = result;
    let hops = 0;
    while (node && typeof node.properties === "object" && (node.properties as Record<string, unknown>).next && hops < 20) {
      node = (node.properties as Record<string, unknown>).next as typeof result;
      hops++;
    }
    expect(hops).toBeLessThan(9); // never reached the true 10-level-deep leaf
  });
});
