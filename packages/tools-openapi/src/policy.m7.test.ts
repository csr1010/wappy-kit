import { describe, expect, test } from "vitest";
import type { GeneratedTool } from "./operations.js";
import { applyPolicy } from "./policy.js";

function tool(overrides: Partial<GeneratedTool> = {}): GeneratedTool {
  return {
    name: "op",
    description: "x",
    method: "get",
    path: "/x",
    operationId: "op",
    operation: { responses: {} },
    parameters: { type: "object", properties: {} },
    ...overrides,
  };
}

describe("applyPolicy — readOnly default (GET/HEAD only)", () => {
  test("GET is readOnly", () => {
    expect(applyPolicy(tool({ method: "get" })).readOnly).toBe(true);
  });

  test("HEAD is readOnly", () => {
    expect(applyPolicy(tool({ method: "head" })).readOnly).toBe(true);
  });

  test("POST is not readOnly", () => {
    expect(applyPolicy(tool({ method: "post" })).readOnly).toBe(false);
  });

  test("PUT/PATCH/DELETE are not readOnly", () => {
    expect(applyPolicy(tool({ method: "put" })).readOnly).toBe(false);
    expect(applyPolicy(tool({ method: "patch" })).readOnly).toBe(false);
    expect(applyPolicy(tool({ method: "delete", operationId: "del" }), { allowDestructive: true }).readOnly).toBe(false);
  });
});

describe("applyPolicy — confirmBefore for non-GET", () => {
  test("GET/HEAD do not require confirmation", () => {
    expect(applyPolicy(tool({ method: "get" })).confirmBefore).toBe(false);
    expect(applyPolicy(tool({ method: "head" })).confirmBefore).toBe(false);
  });

  test("POST/PUT/PATCH require confirmation", () => {
    expect(applyPolicy(tool({ method: "post" })).confirmBefore).toBe(true);
    expect(applyPolicy(tool({ method: "put" })).confirmBefore).toBe(true);
    expect(applyPolicy(tool({ method: "patch" })).confirmBefore).toBe(true);
  });
});

describe("applyPolicy — DELETE requires explicit opt-in", () => {
  test("a DELETE operation is excluded by default", () => {
    const decision = applyPolicy(tool({ method: "delete" }));
    expect(decision.included).toBe(false);
    expect(decision.reason).toMatch(/delete/i);
  });

  test("a DELETE operation is included when allowDestructive is explicitly true", () => {
    const decision = applyPolicy(tool({ method: "delete" }), { allowDestructive: true });
    expect(decision.included).toBe(true);
    expect(decision.confirmBefore).toBe(true);
  });

  test("allowDestructive alone doesn't bypass a non-matching allowList", () => {
    const decision = applyPolicy(tool({ method: "delete", operationId: "deleteThing" }), { allowDestructive: true, allowList: ["getThing*"] });
    expect(decision.included).toBe(false);
  });
});

describe("applyPolicy — allowList (operationId/tag/glob)", () => {
  test("no allowList means every (non-DELETE) operation is included", () => {
    expect(applyPolicy(tool({ operationId: "anything" })).included).toBe(true);
  });

  test("an exact operationId match is included", () => {
    expect(applyPolicy(tool({ operationId: "getOrders" }), { allowList: ["getOrders"] }).included).toBe(true);
  });

  test("a non-matching operationId is excluded", () => {
    const decision = applyPolicy(tool({ operationId: "getOrders" }), { allowList: ["getProducts"] });
    expect(decision.included).toBe(false);
    expect(decision.reason).toBeTruthy();
  });

  test("a glob pattern matches by prefix", () => {
    expect(applyPolicy(tool({ operationId: "getOrderStatus" }), { allowList: ["getOrder*"] }).included).toBe(true);
  });

  test("a tag match is enough even if operationId doesn't match", () => {
    const t = tool({ operationId: "listWidgets", operation: { responses: {}, tags: ["orders"] } });
    expect(applyPolicy(t, { allowList: ["orders"] }).included).toBe(true);
  });

  test("a glob pattern matches a tag too", () => {
    const t = tool({ operationId: "listWidgets", operation: { responses: {}, tags: ["order-management"] } });
    expect(applyPolicy(t, { allowList: ["order-*"] }).included).toBe(true);
  });

  test("an operation with no operationId and no matching tag still checks its derived name", () => {
    const t = tool({ operationId: undefined, name: "get_widgets", operation: { responses: {} } });
    expect(applyPolicy(t, { allowList: ["get_widgets"] }).included).toBe(true);
  });
});
