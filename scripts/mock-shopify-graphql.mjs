#!/usr/bin/env node
// A small, realistic mock of Shopify's Admin GraphQL API, matching the exact query shapes
// @wappy/tools-openapi's shopify.ts sends (products/orders/inventory/customers/policies) — so the
// real ToolProvider code runs unmodified against it via `graphqlUrlOverride`. Not a general GraphQL
// engine: it string-matches which of the 7 known queries came in and returns canned sample data for
// "Luna & Co.", a fictional candle store. Auth: accepts any X-Shopify-Access-Token (this is a test
// double, not a security boundary).
//
// Usage: node scripts/mock-shopify-graphql.mjs [port]   (default 8899)
import { createServer } from "node:http";

const PORT = Number(process.argv[2] ?? 8899);

const PRODUCTS = [
  { id: "gid://shopify/Product/1001", title: "Lavender Dream Candle", handle: "lavender-dream-candle", status: "ACTIVE", totalInventory: 42, minPrice: "18.00", maxPrice: "24.00" },
  { id: "gid://shopify/Product/1002", title: "Midnight Amber Candle", handle: "midnight-amber-candle", status: "ACTIVE", totalInventory: 7, minPrice: "22.00", maxPrice: "22.00" },
  { id: "gid://shopify/Product/1003", title: "Citrus Grove Candle", handle: "citrus-grove-candle", status: "ACTIVE", totalInventory: 0, minPrice: "18.00", maxPrice: "18.00" },
];

const ORDERS = [
  {
    id: "gid://shopify/Order/500001",
    name: "#1042",
    status: "FULFILLED",
    financial: "PAID",
    createdAt: "2026-09-15T14:22:00Z",
    amount: "46.00",
    tracking: { number: "1Z999AA10123456784", url: "https://www.ups.com/track?tracknum=1Z999AA10123456784" },
  },
  {
    id: "gid://shopify/Order/500002",
    name: "#1043",
    status: "UNFULFILLED",
    financial: "PAID",
    createdAt: "2026-09-19T09:05:00Z",
    amount: "22.00",
    tracking: null,
  },
  {
    id: "gid://shopify/Order/500003",
    name: "#8842",
    status: "FULFILLED",
    financial: "PAID",
    createdAt: "2026-09-10T11:00:00Z",
    amount: "18.00",
    tracking: { number: "9400111899223197428450", url: "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223197428450" },
  },
];

const CUSTOMERS = [{ id: "gid://shopify/Customer/900001", displayName: "Jordan Lee", email: "jordan@example.com", numberOfOrders: 3, amountSpent: "86.00", tags: ["vip"] }];

const INVENTORY = { "CANDLE-LAV-8OZ": [{ name: "Main Warehouse", qty: 42 }], "CANDLE-AMB-8OZ": [{ name: "Main Warehouse", qty: 7 }] };

const SHOP_POLICIES = {
  shippingPolicy: { title: "Shipping Policy", body: "<p>We ship within 1-2 business days. Standard shipping (3-5 days) is $5.99; free over $50. Express (1-2 days) is $14.99.</p>" },
  refundPolicy: { title: "Refund Policy", body: "<p>Returns accepted within 30 days of delivery for unused items in original packaging. Refunds are issued to the original payment method within 5-7 business days of receipt.</p>" },
  privacyPolicy: { title: "Privacy Policy", body: "<p>We collect only what's needed to fulfill your order: name, address, email. We never sell customer data.</p>" },
  termsOfService: { title: "Terms of Service", body: "<p>By ordering from Luna & Co. you agree to pay the listed price plus applicable tax and shipping.</p>" },
};

function productNode(p) {
  return { id: p.id, title: p.title, handle: p.handle, status: p.status, totalInventory: p.totalInventory, priceRangeV2: { minVariantPrice: { amount: p.minPrice, currencyCode: "USD" }, maxVariantPrice: { amount: p.maxPrice, currencyCode: "USD" } } };
}
function orderNode(o) {
  return {
    id: o.id,
    name: o.name,
    displayFulfillmentStatus: o.status,
    displayFinancialStatus: o.financial,
    createdAt: o.createdAt,
    totalPriceSet: { shopMoney: { amount: o.amount, currencyCode: "USD" } },
    fulfillments: o.tracking ? [{ trackingInfo: [o.tracking] }] : [],
  };
}
function customerNode(c) {
  return { id: c.id, displayName: c.displayName, numberOfOrders: c.numberOfOrders, amountSpent: { amount: c.amountSpent, currencyCode: "USD" }, tags: c.tags };
}

// Extracts the quoted value from a Shopify search-filter string like `name:"#1042"` or
// `sku:"CANDLE-LAV-8OZ"` — matches shopify.ts's own `searchFilter()` output shape.
function filterValue(q) {
  const m = /:"((?:[^"\\]|\\.)*)"/.exec(q ?? "");
  return m ? m[1].replace(/\\(["\\])/g, "$1") : q;
}

function respond(query, variables) {
  const has = (s) => query.includes(s);

  if (has("shippingPolicy") && has("shop {")) {
    return { shop: SHOP_POLICIES };
  }
  if (has("products(first:") && has("query: $q")) {
    const needle = (variables?.q ?? "").toLowerCase();
    const matched = PRODUCTS.filter((p) => p.title.toLowerCase().includes(needle) || needle === "");
    return { products: { edges: matched.map((p) => ({ node: productNode(p) })) } };
  }
  if (has("product(id:")) {
    const p = PRODUCTS.find((p) => p.id === variables?.id);
    return { product: p ? productNode(p) : null };
  }
  if (has("order(id:")) {
    const o = ORDERS.find((o) => o.id === variables?.id);
    return { order: o ? orderNode(o) : null };
  }
  if (has("orders(first:") && has("query: $q")) {
    const name = filterValue(variables?.q);
    const matched = ORDERS.filter((o) => o.name === name);
    return { orders: { edges: matched.map((o) => ({ node: orderNode(o) })) } };
  }
  if (has("orders(first:")) {
    // listRecentOrders — no filter, newest first (list is already in that order above).
    const first = variables?.first ?? 10;
    return { orders: { edges: ORDERS.slice(0, first).map((o) => ({ node: orderNode(o) })) } };
  }
  if (has("inventoryItems(first:")) {
    const sku = filterValue(variables?.q);
    const levels = INVENTORY[sku];
    if (!levels) return { inventoryItems: { edges: [] } };
    return { inventoryItems: { edges: [{ node: { sku, inventoryLevels: { edges: levels.map((l) => ({ node: { location: { name: l.name }, quantities: [{ name: "available", quantity: l.qty }] } })) } } }] } };
  }
  if (has("customer(id:")) {
    const c = CUSTOMERS.find((c) => c.id === variables?.id);
    return { customer: c ? customerNode(c) : null };
  }
  if (has("customers(first:")) {
    const email = filterValue(variables?.q);
    const matched = CUSTOMERS.filter((c) => c.email === email);
    return { customers: { edges: matched.map((c) => ({ node: customerNode(c) })) } };
  }
  return null;
}

const server = createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (!req.headers["x-shopify-access-token"]) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ errors: [{ message: "Missing X-Shopify-Access-Token" }] }));
      return;
    }
    let query, variables;
    try {
      ({ query, variables } = JSON.parse(body));
    } catch {
      res.writeHead(400).end();
      return;
    }
    const data = respond(query ?? "", variables ?? {});
    if (data === null) {
      console.error("mock-shopify-graphql: unrecognized query:\n" + query);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ errors: [{ message: "mock server: unrecognized query" }] }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data }));
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock Shopify Admin GraphQL API — Luna & Co. — listening on http://127.0.0.1:${PORT}/admin/api/2026-07/graphql.json`);
  console.log(`Point graphqlUrlOverride (or a generated project's SHOPIFY_GRAPHQL_URL_OVERRIDE, if wired) at that URL.`);
  console.log(`Sample data: products ${PRODUCTS.map((p) => p.title).join(", ")}; orders ${ORDERS.map((o) => o.name).join(", ")}; 1 customer; 4 store policies.`);
});
