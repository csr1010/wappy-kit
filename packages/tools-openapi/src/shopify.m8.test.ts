import { describe, expect, test, vi } from "vitest";
import { createShopifyToolProvider } from "./shopify.js";

const ENV_VAR = "SHOPIFY_ACCESS_TOKEN";
function env(vars: Record<string, string>) {
  return (name: string) => vars[name];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function provider(fetchImpl: () => Promise<Response>, extra: Partial<Parameters<typeof createShopifyToolProvider>[0]> = {}) {
  return createShopifyToolProvider({
    graphqlUrlOverride: "https://shop.example.myshopify.com/admin/api/2026-07/graphql.json",
    accessTokenEnvVar: ENV_VAR,
    envReader: env({ [ENV_VAR]: "shpat_test_token" }),
    ssrf: { allowPrivateNetworks: true, fetchImpl },
    ...extra,
  });
}

describe("createShopifyToolProvider — connector shape", () => {
  test("lists exactly the 6 curated read-only tools", async () => {
    const p = provider(async () => jsonResponse({ data: {} }));
    const tools = p.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["getInventoryLevels", "getOrder", "getProduct", "listRecentOrders", "lookupCustomer", "searchProducts"]);
    for (const t of tools) {
      expect(t.readOnly).toBe(true);
      expect(t.confirmBefore).toBe(false);
    }
  });

  test("requires either storeDomain or graphqlUrlOverride", () => {
    expect(() => createShopifyToolProvider({} as never)).toThrow(/storeDomain/);
  });

  test("derives the GraphQL URL from storeDomain + apiVersion when no override is given", async () => {
    let seenUrl: string | undefined;
    const fetchImpl = async (url: string | URL) => {
      seenUrl = url.toString();
      return jsonResponse({ data: { products: { edges: [] } } });
    };
    const p = createShopifyToolProvider({ storeDomain: "my-shop.myshopify.com", apiVersion: "2025-10", accessTokenEnvVar: ENV_VAR, envReader: env({ [ENV_VAR]: "t" }), ssrf: { fetchImpl } });
    await p.listTools().find((t) => t.name === "searchProducts")!.execute({ query: "x" });
    expect(seenUrl).toBe("https://my-shop.myshopify.com/admin/api/2025-10/graphql.json");
  });
});

describe("createShopifyToolProvider — auth", () => {
  test("sends the access token in the X-Shopify-Access-Token header", async () => {
    let seenHeaders: Headers | undefined;
    const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
      seenHeaders = new Headers(init?.headers);
      return jsonResponse({ data: { products: { edges: [] } } });
    };
    const p = provider(fetchImpl as never);
    await p.listTools().find((t) => t.name === "searchProducts")!.execute({ query: "shoes" });
    expect(seenHeaders?.get("X-Shopify-Access-Token")).toBe("shpat_test_token");
    expect(seenHeaders?.get("Content-Type")).toBe("application/json");
  });

  test("a missing access token env var fails the tool call honestly, never sends a request", async () => {
    const fetchImpl = vi.fn();
    const p = provider(fetchImpl, { envReader: env({}) });
    const result = await p.listTools().find((t) => t.name === "searchProducts")!.execute({ query: "x" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(new RegExp(ENV_VAR));
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("createShopifyToolProvider — searchProducts", () => {
  test("returns shaped products for a query", async () => {
    let seenBody: unknown;
    const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
      seenBody = JSON.parse(init!.body as string);
      return jsonResponse({
        data: {
          products: {
            edges: [
              { node: { id: "gid://shopify/Product/1", title: "Red Shoe", handle: "red-shoe", status: "ACTIVE", totalInventory: 12, priceRangeV2: { minVariantPrice: { amount: "19.99", currencyCode: "USD" }, maxVariantPrice: { amount: "24.99", currencyCode: "USD" } } } },
            ],
          },
        },
      });
    };
    const p = provider(fetchImpl as never);
    const result = await p.listTools().find((t) => t.name === "searchProducts")!.execute({ query: "shoe", limit: 5 });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual([{ id: "gid://shopify/Product/1", title: "Red Shoe", handle: "red-shoe", status: "ACTIVE", inventory: 12, priceRange: { min: "19.99 USD", max: "24.99 USD" } }]);
    expect((seenBody as { variables: { q: string; first: number } }).variables).toEqual({ q: "shoe", first: 5 });
  });

  test("a missing query argument fails without a network call", async () => {
    const fetchImpl = vi.fn();
    const p = provider(fetchImpl);
    const result = await p.listTools().find((t) => t.name === "searchProducts")!.execute({});
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("limit is clamped into [1, 50]", async () => {
    let seenFirst: number | undefined;
    const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
      seenFirst = JSON.parse(init!.body as string).variables.first;
      return jsonResponse({ data: { products: { edges: [] } } });
    };
    const p = provider(fetchImpl as never);
    await p.listTools().find((t) => t.name === "searchProducts")!.execute({ query: "x", limit: 500 });
    expect(seenFirst).toBe(50);
  });
});

describe("createShopifyToolProvider — getProduct", () => {
  test("a bare numeric id is normalized to a full gid", async () => {
    let seenVars: unknown;
    const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
      seenVars = JSON.parse(init!.body as string).variables;
      return jsonResponse({ data: { product: { id: "gid://shopify/Product/42", title: "Widget", handle: "widget", status: "ACTIVE" } } });
    };
    const p = provider(fetchImpl as never);
    const result = await p.listTools().find((t) => t.name === "getProduct")!.execute({ id: "42" });
    expect((seenVars as { id: string }).id).toBe("gid://shopify/Product/42");
    expect(result.ok).toBe(true);
  });

  test("an already-qualified gid is passed through unchanged", async () => {
    let seenVars: unknown;
    const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
      seenVars = JSON.parse(init!.body as string).variables;
      return jsonResponse({ data: { product: { id: "gid://shopify/Product/42", title: "Widget", handle: "widget", status: "ACTIVE" } } });
    };
    const p = provider(fetchImpl as never);
    await p.listTools().find((t) => t.name === "getProduct")!.execute({ id: "gid://shopify/Product/42" });
    expect((seenVars as { id: string }).id).toBe("gid://shopify/Product/42");
  });

  test("a null product (not found) is reported as a failure, not a crash", async () => {
    const fetchImpl = async () => jsonResponse({ data: { product: null } });
    const p = provider(fetchImpl as never);
    const result = await p.listTools().find((t) => t.name === "getProduct")!.execute({ id: "999" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no product/i);
  });
});

describe("createShopifyToolProvider — getOrder (by id or by display name)", () => {
  const orderNode = {
    id: "gid://shopify/Order/1",
    name: "#1001",
    displayFulfillmentStatus: "FULFILLED",
    displayFinancialStatus: "PAID",
    createdAt: "2026-01-01T00:00:00Z",
    totalPriceSet: { shopMoney: { amount: "50.00", currencyCode: "USD" } },
    fulfillments: [{ trackingInfo: [{ number: "1Z999", url: "https://track.example.com/1Z999" }] }],
  };

  test("a numeric id queries order(id:) directly", async () => {
    let seenQuery = "";
    const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
      seenQuery = JSON.parse(init!.body as string).query;
      return jsonResponse({ data: { order: orderNode } });
    };
    const p = provider(fetchImpl as never);
    const result = await p.listTools().find((t) => t.name === "getOrder")!.execute({ id: "8842" });
    expect(seenQuery).toContain("order(id:");
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      id: "gid://shopify/Order/1",
      name: "#1001",
      fulfillmentStatus: "FULFILLED",
      financialStatus: "PAID",
      createdAt: "2026-01-01T00:00:00Z",
      total: "50.00 USD",
      tracking: [{ number: "1Z999", url: "https://track.example.com/1Z999" }],
    });
  });

  test('a display name (e.g. "#1001") is looked up via the orders search query, not order(id:)', async () => {
    let seenQuery = "";
    let seenVars: unknown;
    const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      seenQuery = body.query;
      seenVars = body.variables;
      return jsonResponse({ data: { orders: { edges: [{ node: orderNode }] } } });
    };
    const p = provider(fetchImpl as never);
    const result = await p.listTools().find((t) => t.name === "getOrder")!.execute({ id: "#1001" });
    expect(seenQuery).toContain("orders(first: 1");
    expect((seenVars as { q: string }).q).toBe("name:#1001");
    expect(result.ok).toBe(true);
  });

  test("a name-like id lacking # but containing non-digits is normalized before searching", async () => {
    let seenVars: unknown;
    const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
      seenVars = JSON.parse(init!.body as string).variables;
      return jsonResponse({ data: { orders: { edges: [{ node: orderNode }] } } });
    };
    const p = provider(fetchImpl as never);
    // A pure-digit string is treated as the internal numeric id (direct order(id:) lookup, covered
    // by the "numeric id" test above) — only a non-pure-digit form falls through to the name search.
    await p.listTools().find((t) => t.name === "getOrder")!.execute({ id: "SP1001" });
    expect((seenVars as { q: string }).q).toBe("name:#SP1001");
  });

  test("no matching order by name fails honestly", async () => {
    const fetchImpl = async () => jsonResponse({ data: { orders: { edges: [] } } });
    const p = provider(fetchImpl as never);
    const result = await p.listTools().find((t) => t.name === "getOrder")!.execute({ id: "#9999" });
    expect(result.ok).toBe(false);
  });
});

describe("createShopifyToolProvider — listRecentOrders", () => {
  test("returns shaped orders newest-first", async () => {
    const fetchImpl = async () =>
      jsonResponse({
        data: {
          orders: {
            edges: [{ node: { id: "gid://shopify/Order/2", name: "#1002", createdAt: "2026-02-01T00:00:00Z" } }],
          },
        },
      });
    const p = provider(fetchImpl as never);
    const result = await p.listTools().find((t) => t.name === "listRecentOrders")!.execute({});
    expect(result.ok).toBe(true);
    expect((result.data as unknown[]).length).toBe(1);
  });
});

describe("createShopifyToolProvider — getInventoryLevels", () => {
  test("returns per-location available quantities for a SKU", async () => {
    const fetchImpl = async () =>
      jsonResponse({
        data: {
          inventoryItems: {
            edges: [
              {
                node: {
                  sku: "SKU-1",
                  inventoryLevels: { edges: [{ node: { location: { name: "Warehouse A" }, quantities: [{ name: "available", quantity: 7 }] } }] },
                },
              },
            ],
          },
        },
      });
    const p = provider(fetchImpl as never);
    const result = await p.listTools().find((t) => t.name === "getInventoryLevels")!.execute({ sku: "SKU-1" });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual([{ sku: "SKU-1", location: "Warehouse A", quantities: { available: 7 } }]);
  });

  test("an unknown SKU fails honestly", async () => {
    const fetchImpl = async () => jsonResponse({ data: { inventoryItems: { edges: [] } } });
    const p = provider(fetchImpl as never);
    const result = await p.listTools().find((t) => t.name === "getInventoryLevels")!.execute({ sku: "GHOST" });
    expect(result.ok).toBe(false);
  });
});

describe("createShopifyToolProvider — lookupCustomer (PII minimization, T8.2)", () => {
  test("looks up by email and shapes out email/phone/address entirely", async () => {
    let seenQuery = "";
    const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
      seenQuery = JSON.parse(init!.body as string).query;
      return jsonResponse({
        data: {
          customers: {
            edges: [{ node: { id: "gid://shopify/Customer/1", displayName: "Jordan S.", numberOfOrders: 3, amountSpent: { amount: "150.00", currencyCode: "USD" }, tags: ["vip"], email: "jordan@example.com", phone: "+15551234567" } }],
          },
        },
      });
    };
    const p = provider(fetchImpl as never);
    const result = await p.listTools().find((t) => t.name === "lookupCustomer")!.execute({ email: "jordan@example.com" });
    expect(seenQuery).toContain("customers(first: 1");
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ id: "gid://shopify/Customer/1", displayName: "Jordan S.", ordersCount: 3, totalSpent: "150.00 USD", tags: ["vip"] });
    expect(JSON.stringify(result.data)).not.toContain("jordan@example.com");
    expect(JSON.stringify(result.data)).not.toContain("+15551234567");
  });

  test("looks up by id directly", async () => {
    const fetchImpl = async () => jsonResponse({ data: { customer: { id: "gid://shopify/Customer/9", displayName: "Sam R.", numberOfOrders: 1 } } });
    const p = provider(fetchImpl as never);
    const result = await p.listTools().find((t) => t.name === "lookupCustomer")!.execute({ id: "9" });
    expect(result.ok).toBe(true);
    expect((result.data as { displayName: string }).displayName).toBe("Sam R.");
  });

  test("neither email nor id fails without a network call", async () => {
    const fetchImpl = vi.fn();
    const p = provider(fetchImpl);
    const result = await p.listTools().find((t) => t.name === "lookupCustomer")!.execute({});
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("createShopifyToolProvider — transport/GraphQL error handling (T8.6 groundwork)", () => {
  test("a non-2xx HTTP response is reported as a failed ToolResult, not a thrown exception", async () => {
    const fetchImpl = async () => new Response("service unavailable", { status: 503 });
    const p = provider(fetchImpl as never);
    const result = await p.listTools().find((t) => t.name === "searchProducts")!.execute({ query: "x" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("503");
  });

  test("a GraphQL-level errors array is surfaced even on HTTP 200", async () => {
    const fetchImpl = async () => jsonResponse({ errors: [{ message: "Throttled" }] });
    const p = provider(fetchImpl as never);
    const result = await p.listTools().find((t) => t.name === "searchProducts")!.execute({ query: "x" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Throttled");
  });

  test("a network-level throw (e.g. DNS/connect failure) is caught, not propagated", async () => {
    const fetchImpl = async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    };
    const p = provider(fetchImpl as never);
    const result = await p.listTools().find((t) => t.name === "searchProducts")!.execute({ query: "x" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ENOTFOUND");
  });

  test("a non-JSON response body is reported honestly", async () => {
    const fetchImpl = async () => new Response("<html>not json</html>", { status: 200 });
    const p = provider(fetchImpl as never);
    const result = await p.listTools().find((t) => t.name === "searchProducts")!.execute({ query: "x" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/JSON/);
  });
});
