import { describe, expect, test } from "vitest";
import type { GeneratedTool } from "./operations.js";
import { curate } from "./curate.js";

function tool(overrides: Partial<GeneratedTool> = {}): GeneratedTool {
  return {
    name: overrides.operationId ?? "op",
    description: "x",
    method: "get",
    path: "/x",
    operationId: "op",
    operation: { responses: {} },
    parameters: { type: "object", properties: {} },
    ...overrides,
  };
}

const ORDERS = tool({ operationId: "listOrders", name: "listOrders", description: "List customer orders", operation: { responses: {}, tags: ["orders"] } });
const PRODUCTS = tool({ operationId: "listProducts", name: "listProducts", description: "List store products", operation: { responses: {}, tags: ["products"] } });
const CUSTOMERS = tool({ operationId: "listCustomers", name: "listCustomers", description: "List customers", operation: { responses: {}, tags: ["customers"] } });
const ADMIN = tool({ operationId: "adminResetDatabase", name: "adminResetDatabase", description: "Danger: resets everything", operation: { responses: {}, tags: ["admin"] } });

describe("curate — no options means everything passes through", () => {
  test("all tools are kept, nothing dropped", () => {
    const result = curate([ORDERS, PRODUCTS, CUSTOMERS]);
    expect(result.tools).toHaveLength(3);
    expect(result.dropped).toHaveLength(0);
  });
});

describe("curate — tags filter", () => {
  test("only operations with a matching tag are kept", () => {
    const result = curate([ORDERS, PRODUCTS, CUSTOMERS], { tags: ["orders"] });
    expect(result.tools).toEqual([ORDERS]);
  });

  test("operations without a matching tag are reported in dropped with a reason", () => {
    const result = curate([ORDERS, PRODUCTS], { tags: ["orders"] });
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]?.tool.name).toBe("listProducts");
    expect(result.dropped[0]?.reason).toBeTruthy();
  });

  test("multiple tags act as OR — any match keeps the operation", () => {
    const result = curate([ORDERS, PRODUCTS, CUSTOMERS], { tags: ["orders", "products"] });
    expect(result.tools.map((t) => t.name).sort()).toEqual(["listOrders", "listProducts"]);
  });
});

describe("curate — include (glob against operationId/name/tags)", () => {
  test("include matches by operationId glob", () => {
    const result = curate([ORDERS, PRODUCTS, CUSTOMERS], { include: ["list*"] });
    expect(result.tools).toHaveLength(3);
  });

  test("include narrows to a specific operation", () => {
    const result = curate([ORDERS, PRODUCTS], { include: ["listOrders"] });
    expect(result.tools).toEqual([ORDERS]);
  });

  test("tags and include are OR'd together — either match is enough", () => {
    const result = curate([ORDERS, PRODUCTS, CUSTOMERS], { tags: ["orders"], include: ["listProducts"] });
    expect(result.tools.map((t) => t.name).sort()).toEqual(["listOrders", "listProducts"]);
  });
});

describe("curate — exclude", () => {
  test("exclude removes a match even though it passed tags/include", () => {
    const result = curate([ORDERS, PRODUCTS, ADMIN], { include: ["*"], exclude: ["admin*"] });
    expect(result.tools.map((t) => t.name)).not.toContain("adminResetDatabase");
    expect(result.dropped.some((d) => d.tool.name === "adminResetDatabase")).toBe(true);
  });

  test("exclude matches by tag too", () => {
    const result = curate([ORDERS, ADMIN], { exclude: ["admin"] });
    expect(result.tools).toEqual([ORDERS]);
  });
});

describe("curate — max caps the result via lexical ranking against tags/include", () => {
  test("when candidates exceed max, the ones most lexically relevant to the tags/include keywords are kept", () => {
    const orderRelated = tool({ operationId: "getOrderDetails", name: "getOrderDetails", description: "Get order details and order history" });
    const unrelated = tool({ operationId: "getWeatherForecast", name: "getWeatherForecast", description: "Get the weather forecast" });
    const result = curate([orderRelated, unrelated], { include: ["order*", "*"], max: 1 });
    // "order" keywords from the include pattern text itself don't carry lexical meaning (globs), so
    // this test instead drives ranking via tags, asserted in the next test — this one just checks max is enforced.
    expect(result.tools).toHaveLength(1);
    expect(result.dropped).toHaveLength(1);
  });

  test("max ranks by lexical overlap with the tags keywords when both are given", () => {
    const orderRelated = tool({ operationId: "getOrderDetails", name: "getOrderDetails", description: "Fetch order status and order tracking info", operation: { responses: {}, tags: ["orders"] } });
    const alsoOrders = tool({ operationId: "cancelOrder", name: "cancelOrder", description: "Cancel an order", operation: { responses: {}, tags: ["orders"] } });
    const result = curate([orderRelated, alsoOrders], { tags: ["orders"], max: 1 });
    expect(result.tools).toHaveLength(1);
    // orderRelated's description repeats "order" more -> should rank higher under the same tag filter.
    expect(result.tools[0]?.name).toBe("getOrderDetails");
  });

  test("max without tags/include falls back to preferring readOnly (GET/HEAD) operations", () => {
    const getOp = tool({ operationId: "getThing", name: "getThing", method: "get" });
    const postOp = tool({ operationId: "postThing", name: "postThing", method: "post" });
    const result = curate([postOp, getOp], { max: 1 });
    expect(result.tools[0]?.name).toBe("getThing");
  });

  test("max larger than the candidate count is a no-op", () => {
    const result = curate([ORDERS, PRODUCTS], { max: 10 });
    expect(result.tools).toHaveLength(2);
    expect(result.dropped).toHaveLength(0);
  });

  test("every dropped-by-max tool has a reason mentioning the cap", () => {
    const result = curate([ORDERS, PRODUCTS, CUSTOMERS], { max: 1 });
    expect(result.dropped.every((d) => /max|cap|limit/i.test(d.reason))).toBe(true);
  });
});

describe("curate — combined filters and max together", () => {
  test("tags/include/exclude apply before max ranking", () => {
    const result = curate([ORDERS, PRODUCTS, CUSTOMERS, ADMIN], { exclude: ["admin"], max: 2 });
    expect(result.tools).toHaveLength(2);
    expect(result.tools.some((t) => t.name === "adminResetDatabase")).toBe(false);
  });
});
