import type { OpenAPIV3 } from "openapi-types";

/** Resource names used to spread synthetic operations across many distinct paths/tags, mirroring
 * what a real large SaaS API (e.g. Shopify) looks like — dozens of resources, several operations
 * each, rather than one resource with hundreds of near-duplicate operations. */
const RESOURCES = [
  "orders", "products", "customers", "inventory", "invoices", "shipments", "refunds", "coupons",
  "reviews", "subscriptions", "carts", "checkouts", "discounts", "collections", "variants",
  "fulfillments", "locations", "warehouses", "suppliers", "purchaseOrders", "taxRates", "shippingZones",
  "paymentMethods", "webhooks", "metafields", "themes", "pages", "blogs", "articles", "comments",
  "giftCards", "priceRules", "draftOrders", "transactions", "disputes", "payouts", "balances",
  "reports", "analyticsEvents", "customerGroups", "segments", "campaigns", "automations", "flows",
  "apps", "scripts", "redirects", "domains", "files", "assets", "translations", "markets", "carriers",
  "returnPolicies", "returns", "exchanges", "storeCredit", "loyaltyPoints", "referrals", "affiliates",
  "vendors", "brands", "categories", "attributes", "bundles", "kits", "subscriptions2", "plans",
  "invitations", "roles", "permissions", "auditLogs", "sessions", "apiKeys", "integrations", "syncJobs",
  "importJobs", "exportJobs", "notifications", "templates", "emailCampaigns", "smsCampaigns",
  "pushCampaigns", "surveys", "feedback", "tickets", "macros", "canned", "agents", "queues", "slas",
  "escalations", "onCallSchedules", "incidents", "postmortems", "runbooks", "changeRequests", "assets2",
  "licenses", "contracts", "renewals", "quotes",
];

/** 20 distinctive, richly-described operations — mirrors M6's tool-selector.ts test pattern (20
 * distinctive targets + filler) so a cross-package test can prove harness's BM25 selector still
 * finds the right tool among ~800 generated from a real (if synthetic) large spec. */
const DISTINCTIVE: { path: string; method: string; operationId: string; summary: string; tag: string }[] = [
  { path: "/orders/{orderId}/status", method: "get", operationId: "getOrderStatus", summary: "Look up the current shipping status of a specific order by its order id", tag: "orders" },
  { path: "/products/search", method: "get", operationId: "searchProductCatalog", summary: "Search the product catalog by keyword, category, or price range", tag: "products" },
  { path: "/customers/{customerId}/loyalty", method: "get", operationId: "getCustomerLoyaltyBalance", summary: "Fetch a customer's current loyalty points balance", tag: "customers" },
  { path: "/inventory/{sku}/availability", method: "get", operationId: "checkInventoryAvailability", summary: "Check how many units of a SKU are currently in stock", tag: "inventory" },
  { path: "/refunds", method: "post", operationId: "issueRefund", summary: "Issue a refund for a completed order", tag: "refunds" },
  { path: "/shipments/{shipmentId}/tracking", method: "get", operationId: "getShipmentTrackingInfo", summary: "Get the carrier tracking number and delivery estimate for a shipment", tag: "shipments" },
  { path: "/coupons/validate", method: "post", operationId: "validateCouponCode", summary: "Validate whether a discount coupon code is currently active and applicable", tag: "coupons" },
  { path: "/reviews", method: "post", operationId: "submitProductReview", summary: "Submit a customer's star rating and written review for a product", tag: "reviews" },
  { path: "/subscriptions/{subscriptionId}/cancel", method: "post", operationId: "cancelSubscription", summary: "Cancel a customer's recurring subscription", tag: "subscriptions" },
  { path: "/carts/{cartId}/items", method: "post", operationId: "addItemToCart", summary: "Add a product variant to a shopping cart", tag: "carts" },
  { path: "/giftCards/{code}/balance", method: "get", operationId: "checkGiftCardBalance", summary: "Check the remaining balance on a gift card by its code", tag: "giftCards" },
  { path: "/returns", method: "post", operationId: "startReturnRequest", summary: "Start a return request for items from a delivered order", tag: "returns" },
  { path: "/disputes/{disputeId}/evidence", method: "post", operationId: "submitDisputeEvidence", summary: "Submit supporting evidence for a payment chargeback dispute", tag: "disputes" },
  { path: "/reports/sales", method: "get", operationId: "getSalesReport", summary: "Generate a sales report for a given date range", tag: "reports" },
  { path: "/webhooks", method: "post", operationId: "registerWebhook", summary: "Register a new webhook endpoint to receive event notifications", tag: "webhooks" },
  { path: "/tickets/{ticketId}/reply", method: "post", operationId: "replyToSupportTicket", summary: "Post a reply message on an existing customer support ticket", tag: "tickets" },
  { path: "/vendors/{vendorId}/rating", method: "get", operationId: "getVendorRating", summary: "Get a supplier vendor's average performance rating", tag: "vendors" },
  { path: "/priceRules", method: "post", operationId: "createPriceRule", summary: "Create a new automatic pricing rule for a product collection", tag: "priceRules" },
  { path: "/notifications/preferences", method: "get", operationId: "getNotificationPreferences", summary: "Fetch a customer's notification channel preferences (email/SMS/push)", tag: "notifications" },
  { path: "/campaigns/{campaignId}/performance", method: "get", operationId: "getCampaignPerformance", summary: "Get open/click/conversion metrics for a marketing campaign", tag: "campaigns" },
];

function pathParamNames(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
}

function op(operationId: string, summary: string, tag: string, method: string, path: string, requestBody: boolean): OpenAPIV3.OperationObject {
  const parameters: OpenAPIV3.ParameterObject[] = pathParamNames(path).map((name) => ({ name, in: "path", required: true, schema: { type: "string" } }));
  const operation: OpenAPIV3.OperationObject = {
    operationId,
    summary,
    tags: [tag],
    parameters,
    responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object" } } } } },
  };
  if (requestBody && (method === "post" || method === "put" || method === "patch")) {
    operation.requestBody = { required: true, content: { "application/json": { schema: { type: "object", properties: { value: { type: "string" } } } } } };
  }
  return operation;
}

/**
 * Generates a synthetic OpenAPI 3.0 document with roughly `operationCount` operations spread across
 * many distinct resources/tags (§8 T7.10, "synthetic 800-operation spec generator") — kept in-memory
 * rather than a committed/gitignored file, since `loadSpec()` accepts an already-parsed object
 * directly, and an in-memory generator needs no separate regeneration step in CI for a gitignored
 * fixture to exist (see PROGRESS.md's T7.10 log entry for the full reasoning).
 */
export function generateHugeSpec(operationCount = 800): OpenAPIV3.Document {
  const paths: OpenAPIV3.PathsObject = {};
  let count = 0;

  for (const d of DISTINCTIVE) {
    paths[d.path] = { ...(paths[d.path] as object), [d.method]: op(d.operationId, d.summary, d.tag, d.method, d.path, true) };
    count++;
  }

  const methodsPerResource: { method: string; suffix: string; body: boolean }[] = [
    { method: "get", suffix: "", body: false },
    { method: "post", suffix: "", body: true },
    { method: "get", suffix: "/{id}", body: false },
    { method: "put", suffix: "/{id}", body: true },
    { method: "patch", suffix: "/{id}", body: true },
    { method: "delete", suffix: "/{id}", body: false },
    { method: "get", suffix: "/{id}/history", body: false },
    { method: "get", suffix: "/search", body: false },
  ];

  outer: for (const resource of RESOURCES) {
    for (const m of methodsPerResource) {
      if (count >= operationCount) break outer;
      const path = `/${resource}${m.suffix}`;
      const existing = (paths[path] as Record<string, unknown>) ?? {};
      if (m.method in existing) continue; // a DISTINCTIVE entry already claimed this exact path+method — never overwrite it
      const operationId = `${m.method}_${resource}${m.suffix.replace(/[{}/]/g, "_")}`;
      paths[path] = { ...existing, [m.method]: op(operationId, `${m.method.toUpperCase()} ${resource}${m.suffix}`, resource, m.method, path, m.body) };
      count++;
    }
  }

  return {
    openapi: "3.0.3",
    info: { title: "Synthetic huge API", version: "1.0.0" },
    servers: [{ url: "https://api.example.com" }],
    paths,
  };
}
