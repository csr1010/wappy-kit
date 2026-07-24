import type { Tool, ToolProvider, ToolResult } from "@wappy/core";
import { fetchSafely, type SafeFetchOptions } from "./ssrf.js";

/**
 * Shopify connector (§8 T8.1/T8.2): a small, hand-picked `ToolProvider` — NOT produced by this
 * package's OpenAPI `loadSpec()`/`generateTools()` pipeline, because Shopify's real, current, and
 * only supported API for these resources is the GraphQL Admin API (verified against official docs
 * 2026-09-21 — see docs/PROGRESS.md T8.0 entry: the REST Admin API is deprecated, and REST's
 * product/variant endpoints have already stopped working). GraphQL has no OpenAPI/Swagger spec to
 * feed the generic engine, so every tool here is a hand-written query against a single POST
 * endpoint — matching the spec's own "Shopify connector = hand-picked tools... Underlying engine
 * stays generic OpenAPI" (§8). Read-only by default (T8.1): every tool here is a GraphQL query,
 * never a mutation.
 */

const DEFAULT_API_VERSION = "2026-07";
const DEFAULT_ACCESS_TOKEN_ENV_VAR = "SHOPIFY_ACCESS_TOKEN";
const DEFAULT_TIMEOUT_MS = 10_000;

export interface CreateShopifyToolProviderOptions {
  /** ToolProvider name, e.g. surfaced in skipReport-style diagnostics elsewhere. Default "shopify". */
  name?: string;
  /** e.g. "my-shop.myshopify.com" — required unless `graphqlUrlOverride` is supplied. */
  storeDomain?: string;
  /** Shopify's `YYYY-MM` quarterly release version (T8.0). Default a recent stable one; configurable
   * per-connector since a store may need to pin an older supported version. */
  apiVersion?: string;
  /** Env var holding the custom-app access token (T8.1 "token from env"). Default "SHOPIFY_ACCESS_TOKEN". */
  accessTokenEnvVar?: string;
  /** Reads a secret by env-var name at CALL time (not install time), matching tools-openapi's own
   * executor convention. Defaults to `process.env`. */
  envReader?: (name: string) => string | undefined;
  /** Bypasses `storeDomain`/`apiVersion`'s derived URL — for tests pointing at a local fixture
   * server, or an operator who needs the raw GraphQL endpoint for some other reason. */
  graphqlUrlOverride?: string;
  timeoutMs?: number;
  ssrf?: SafeFetchOptions;
}

function graphqlUrl(opts: CreateShopifyToolProviderOptions): string {
  if (opts.graphqlUrlOverride) return opts.graphqlUrlOverride;
  if (!opts.storeDomain) {
    throw new Error('createShopifyToolProvider: either "storeDomain" or "graphqlUrlOverride" is required.');
  }
  const version = opts.apiVersion ?? DEFAULT_API_VERSION;
  return `https://${opts.storeDomain}/admin/api/${version}/graphql.json`;
}

interface GraphQLError {
  message: string;
}
interface GraphQLResponse {
  data?: unknown;
  errors?: GraphQLError[];
}

/** POSTs one GraphQL request through the SSRF guard, always draining the response body (§8 T7.8's
 * own contract: every `fetchSafely()` caller must drain/cancel what it gets back) and distinguishing
 * transport failures, non-2xx HTTP, and GraphQL-level `errors` — each surfaced as a plain string so
 * every tool's `execute()` can report an honest `ToolResult` instead of throwing (§10). */
async function shopifyGraphQL(
  url: string,
  accessToken: string,
  query: string,
  variables: Record<string, unknown> | undefined,
  timeoutMs: number,
  ssrfOptions: SafeFetchOptions | undefined,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  let response: Response;
  try {
    response = await fetchSafely(url, {
      ...ssrfOptions,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(timeoutMs),
      },
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  const text = await response.text();
  if (!response.ok) return { ok: false, error: `Shopify API HTTP ${response.status}: ${text.slice(0, 500)}` };

  let parsed: GraphQLResponse;
  try {
    parsed = JSON.parse(text) as GraphQLResponse;
  } catch {
    return { ok: false, error: "Shopify API returned a response that wasn't valid JSON." };
  }
  if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
    return { ok: false, error: `Shopify GraphQL error: ${parsed.errors.map((e) => e.message).join("; ")}` };
  }
  if (parsed.data === undefined) return { ok: false, error: "Shopify API response had no data." };
  return { ok: true, data: parsed.data };
}

/** Shopify GraphQL global ids look like `gid://shopify/Product/123456789` — accept either a bare
 * numeric id (the ergonomic form a model is more likely to have extracted from a user message) or
 * an already-fully-qualified gid, so a tool's `id` parameter works either way. */
function toGid(resource: string, id: string): string {
  return id.startsWith("gid://") ? id : `gid://shopify/${resource}/${id}`;
}

/** Builds one `field:"value"` term for Shopify's search-filter mini-language (used by every
 * `query:` GraphQL variable below) with `value` quoted and escaped — NOT raw string concatenation.
 * Shopify's search syntax has its own operators (`OR`/`AND`/`-`/`*`/parentheses/other `field:`
 * terms); passing a model-extracted value through unquoted (e.g. `sku:${sku}`) lets a value like
 * `x OR sku:*` widen the filter to match arbitrary records instead of the one the caller asked
 * about — a real scoping bug, not just a hardening exercise, since every value here (order name,
 * SKU, email) ultimately traces back to text a model pulled out of a user's message. Quoting turns
 * the whole value into one literal term; Shopify search syntax reserves only `"` and `\` inside a
 * quoted term, both escaped here. */
function searchFilter(field: string, value: string): string {
  return `${field}:"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function money(node: unknown): string | undefined {
  const m = node as { amount?: string; currencyCode?: string } | undefined;
  if (!m?.amount) return undefined;
  return m.currencyCode ? `${m.amount} ${m.currencyCode}` : m.amount;
}

interface ProductNode {
  id: string;
  title: string;
  handle: string;
  status: string;
  totalInventory?: number;
  priceRangeV2?: { minVariantPrice?: unknown; maxVariantPrice?: unknown };
}

/** Response shaping (T8.2): trims a raw GraphQL product node to the fields a model actually needs
 * to answer a shopping question — not the full node (variants, images, metafields, SEO, ...), which
 * would blow the M6 per-section token budget on a single product and adds nothing the reference
 * skills need. */
function shapeProduct(node: ProductNode): Record<string, unknown> {
  return {
    id: node.id,
    title: node.title,
    handle: node.handle,
    status: node.status,
    inventory: node.totalInventory,
    priceRange:
      node.priceRangeV2?.minVariantPrice || node.priceRangeV2?.maxVariantPrice
        ? { min: money(node.priceRangeV2.minVariantPrice), max: money(node.priceRangeV2.maxVariantPrice) }
        : undefined,
  };
}

interface OrderNode {
  id: string;
  name: string;
  displayFulfillmentStatus?: string;
  displayFinancialStatus?: string;
  createdAt?: string;
  totalPriceSet?: { shopMoney?: unknown };
  fulfillments?: { trackingInfo?: { number?: string; url?: string }[] }[];
}

/** Trims an order node to support-relevant fields — deliberately omits the customer's full name,
 * email, phone and shipping address from the default shape (PII minimization, §11/T8.2: an LLM
 * provider doesn't need a customer's home address to answer "where's my order", and every field
 * included here is one more thing sent to a third-party model API on every call). A caller that
 * genuinely needs contact details can still reach them via `lookupCustomer` explicitly. */
function shapeOrder(node: OrderNode): Record<string, unknown> {
  const tracking = node.fulfillments?.flatMap((f) => f.trackingInfo ?? []).filter((t) => t.number) ?? [];
  return {
    id: node.id,
    name: node.name,
    fulfillmentStatus: node.displayFulfillmentStatus,
    financialStatus: node.displayFinancialStatus,
    createdAt: node.createdAt,
    total: money(node.totalPriceSet?.shopMoney),
    tracking: tracking.length > 0 ? tracking.map((t) => ({ number: t.number, url: t.url })) : undefined,
  };
}

interface InventoryLevelNode {
  quantities?: { name?: string; quantity?: number }[];
  location?: { name?: string };
  item?: { sku?: string };
}

function shapeInventoryLevel(node: InventoryLevelNode): Record<string, unknown> {
  return {
    sku: node.item?.sku,
    location: node.location?.name,
    quantities: Object.fromEntries((node.quantities ?? []).filter((q) => q.name).map((q) => [q.name, q.quantity])),
  };
}

interface CustomerNode {
  id: string;
  displayName?: string;
  numberOfOrders?: number;
  amountSpent?: unknown;
  tags?: string[];
}

/** PII minimization (§11/T8.2): deliberately omits email, phone, and address entirely — a support
 * conversation about order status or account history doesn't need them surfaced to the model, and
 * `displayName` alone (Shopify's own "first + last initial or similar" convention) is enough for a
 * natural reply like "Hi Jordan, here's your order history." */
function shapeCustomer(node: CustomerNode): Record<string, unknown> {
  return {
    id: node.id,
    displayName: node.displayName,
    ordersCount: node.numberOfOrders,
    totalSpent: money(node.amountSpent),
    tags: node.tags && node.tags.length > 0 ? node.tags : undefined,
  };
}

function failed(toolName: string, error: string): ToolResult {
  return { toolName, ok: false, error };
}
function ok(toolName: string, data: unknown): ToolResult {
  return { toolName, ok: true, data };
}

/** Builds a real, executable Shopify `ToolProvider` (§8 T8.1/T8.2): products (search/get), orders
 * (get by id/name, list recent), inventory levels, customers (lookup) — every tool a real GraphQL
 * Admin API call, SSRF-guarded, response shaped to what a model needs.
 */
export function createShopifyToolProvider(opts: CreateShopifyToolProviderOptions): ToolProvider {
  const url = graphqlUrl(opts);
  const envReader = opts.envReader ?? ((name: string) => process.env[name]);
  const accessTokenEnvVar = opts.accessTokenEnvVar ?? DEFAULT_ACCESS_TOKEN_ENV_VAR;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  function call(query: string, variables: Record<string, unknown> | undefined) {
    const accessToken = envReader(accessTokenEnvVar);
    if (!accessToken) {
      return Promise.resolve({ ok: false as const, error: `Missing Shopify access token — set the "${accessTokenEnvVar}" environment variable.` });
    }
    return shopifyGraphQL(url, accessToken, query, variables, timeoutMs, opts.ssrf);
  }

  const tools: Tool[] = [
    {
      name: "searchProducts",
      description: "Search the store's products by title/tag/type keywords. Returns id, title, handle, status, inventory, and price range for each match.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free-text search, e.g. a product name or keyword." },
          limit: { type: "integer", minimum: 1, maximum: 50, description: "Max products to return. Default 10." },
        },
        required: ["query"],
      },
      readOnly: true,
      confirmBefore: false,
      async execute(args): Promise<ToolResult> {
        const { query: q, limit } = (args ?? {}) as { query?: string; limit?: number };
        if (!q) return failed("searchProducts", 'Missing required "query" argument.');
        const first = Math.min(Math.max(limit ?? 10, 1), 50);
        const result = await call(
          `query($q: String!, $first: Int!) { products(first: $first, query: $q) { edges { node { id title handle status totalInventory priceRangeV2 { minVariantPrice { amount currencyCode } maxVariantPrice { amount currencyCode } } } } } }`,
          { q, first },
        );
        if (!result.ok) return failed("searchProducts", result.error);
        const edges = ((result.data as { products?: { edges?: { node: ProductNode }[] } })?.products?.edges ?? []) as { node: ProductNode }[];
        return ok("searchProducts", edges.map((e) => shapeProduct(e.node)));
      },
    },
    {
      name: "getProduct",
      description: "Get one product by its id.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: 'Product id — a bare numeric id or a full "gid://shopify/Product/..." id.' } },
        required: ["id"],
      },
      readOnly: true,
      confirmBefore: false,
      async execute(args): Promise<ToolResult> {
        const { id } = (args ?? {}) as { id?: string };
        if (!id) return failed("getProduct", 'Missing required "id" argument.');
        const result = await call(
          `query($id: ID!) { product(id: $id) { id title handle status totalInventory priceRangeV2 { minVariantPrice { amount currencyCode } maxVariantPrice { amount currencyCode } } } }`,
          { id: toGid("Product", id) },
        );
        if (!result.ok) return failed("getProduct", result.error);
        const node = (result.data as { product?: ProductNode }).product;
        if (!node) return failed("getProduct", `No product found for id "${id}".`);
        return ok("getProduct", shapeProduct(node));
      },
    },
    {
      name: "getOrder",
      description: 'Get one order by its numeric id or its display name (e.g. "#1001").',
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: 'Order id (bare numeric, full gid, or display name like "#1001" / "1001").' } },
        required: ["id"],
      },
      readOnly: true,
      confirmBefore: false,
      async execute(args): Promise<ToolResult> {
        const { id } = (args ?? {}) as { id?: string };
        if (!id) return failed("getOrder", 'Missing required "id" argument.');
        // Only an id that's ALREADY a fully-qualified Shopify gid is fetched directly — everything
        // else, including a bare digit string, is treated as a customer-facing order NUMBER (looked
        // up via the search query filter instead, since order.name isn't a valid `order(id:)`
        // argument). This matters: a model extracting an order number from a message like "where's
        // my order 8842?" produces the bare digits "8842", NOT Shopify's own opaque internal numeric
        // id (typically a much larger, unrelated number) — treating bare digits as that internal id
        // would send this tool's own flagship scenario to the wrong lookup and falsely report "not
        // found" on every real call. A caller that already holds a genuine gid (e.g. from a prior
        // listRecentOrders result) can still look it up directly via the gid branch below.
        if (id.startsWith("gid://")) {
          const result = await call(`query($id: ID!) { order(id: $id) { id name displayFulfillmentStatus displayFinancialStatus createdAt totalPriceSet { shopMoney { amount currencyCode } } fulfillments { trackingInfo { number url } } } }`, {
            id: toGid("Order", id),
          });
          if (!result.ok) return failed("getOrder", result.error);
          const node = (result.data as { order?: OrderNode }).order;
          if (!node) return failed("getOrder", `No order found for id "${id}".`);
          return ok("getOrder", shapeOrder(node));
        }
        const name = id.startsWith("#") ? id : `#${id}`;
        const result = await call(
          `query($q: String!) { orders(first: 1, query: $q) { edges { node { id name displayFulfillmentStatus displayFinancialStatus createdAt totalPriceSet { shopMoney { amount currencyCode } } fulfillments { trackingInfo { number url } } } } } }`,
          { q: searchFilter("name", name) },
        );
        if (!result.ok) return failed("getOrder", result.error);
        const edges = ((result.data as { orders?: { edges?: { node: OrderNode }[] } })?.orders?.edges ?? []) as { node: OrderNode }[];
        if (edges.length === 0) return failed("getOrder", `No order found for "${id}".`);
        return ok("getOrder", shapeOrder(edges[0]!.node));
      },
    },
    {
      name: "listRecentOrders",
      description: "List the most recently created orders.",
      parameters: {
        type: "object",
        properties: { limit: { type: "integer", minimum: 1, maximum: 50, description: "Max orders to return. Default 10." } },
        required: [],
      },
      readOnly: true,
      confirmBefore: false,
      async execute(args): Promise<ToolResult> {
        const { limit } = (args ?? {}) as { limit?: number };
        const first = Math.min(Math.max(limit ?? 10, 1), 50);
        const result = await call(
          `query($first: Int!) { orders(first: $first, sortKey: CREATED_AT, reverse: true) { edges { node { id name displayFulfillmentStatus displayFinancialStatus createdAt totalPriceSet { shopMoney { amount currencyCode } } fulfillments { trackingInfo { number url } } } } } }`,
          { first },
        );
        if (!result.ok) return failed("listRecentOrders", result.error);
        const edges = ((result.data as { orders?: { edges?: { node: OrderNode }[] } })?.orders?.edges ?? []) as { node: OrderNode }[];
        return ok("listRecentOrders", edges.map((e) => shapeOrder(e.node)));
      },
    },
    {
      name: "getInventoryLevels",
      description: "Get current inventory levels for a product variant's SKU, across store locations.",
      parameters: {
        type: "object",
        properties: { sku: { type: "string", description: "The variant SKU to look up." } },
        required: ["sku"],
      },
      readOnly: true,
      confirmBefore: false,
      async execute(args): Promise<ToolResult> {
        const { sku } = (args ?? {}) as { sku?: string };
        if (!sku) return failed("getInventoryLevels", 'Missing required "sku" argument.');
        const result = await call(
          `query($q: String!) { inventoryItems(first: 1, query: $q) { edges { node { sku inventoryLevels(first: 20) { edges { node { location { name } quantities(names: ["available"]) { name quantity } } } } } } } }`,
          { q: searchFilter("sku", sku) },
        );
        if (!result.ok) return failed("getInventoryLevels", result.error);
        const edges = ((result.data as { inventoryItems?: { edges?: { node: { sku?: string; inventoryLevels?: { edges?: { node: InventoryLevelNode }[] } } }[] } })?.inventoryItems?.edges ?? []) as {
          node: { sku?: string; inventoryLevels?: { edges?: { node: InventoryLevelNode }[] } };
        }[];
        if (edges.length === 0) return failed("getInventoryLevels", `No inventory item found for SKU "${sku}".`);
        const item = edges[0]!.node;
        const levels = (item.inventoryLevels?.edges ?? []).map((e) => shapeInventoryLevel({ ...e.node, item: { sku: item.sku } }));
        return ok("getInventoryLevels", levels);
      },
    },
    {
      name: "lookupCustomer",
      description: "Look up a customer by email or id. Returns display name and order history summary only — no contact/address details.",
      parameters: {
        type: "object",
        properties: { email: { type: "string", description: "Customer email address to search by." }, id: { type: "string", description: 'Customer id, if known (bare numeric or full "gid://shopify/Customer/..." id).' } },
        required: [],
      },
      readOnly: true,
      confirmBefore: false,
      async execute(args): Promise<ToolResult> {
        const { email, id } = (args ?? {}) as { email?: string; id?: string };
        if (!email && !id) return failed("lookupCustomer", 'Provide either "email" or "id".');
        if (id) {
          const result = await call(`query($id: ID!) { customer(id: $id) { id displayName numberOfOrders amountSpent { amount currencyCode } tags } }`, { id: toGid("Customer", id) });
          if (!result.ok) return failed("lookupCustomer", result.error);
          const node = (result.data as { customer?: CustomerNode }).customer;
          if (!node) return failed("lookupCustomer", `No customer found for id "${id}".`);
          return ok("lookupCustomer", shapeCustomer(node));
        }
        const result = await call(
          `query($q: String!) { customers(first: 1, query: $q) { edges { node { id displayName numberOfOrders amountSpent { amount currencyCode } tags } } } }`,
          { q: searchFilter("email", email!) },
        );
        if (!result.ok) return failed("lookupCustomer", result.error);
        const edges = ((result.data as { customers?: { edges?: { node: CustomerNode }[] } })?.customers?.edges ?? []) as { node: CustomerNode }[];
        if (edges.length === 0) return failed("lookupCustomer", `No customer found for "${email}".`);
        return ok("lookupCustomer", shapeCustomer(edges[0]!.node));
      },
    },
  ];

  return { name: opts.name ?? "shopify", listTools: () => tools };
}
