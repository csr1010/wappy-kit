import type { ToolsAnswer } from "./interview.js";
import type { EnvVarSpec, GeneratedFile } from "./templates.js";

/**
 * Everything Shopify-specific in the generator, isolated here on purpose: Shopify is currently the
 * only `tools` option, but it's the one genuinely domain-tied piece of an otherwise generic
 * install — `@wappy/core`/`@wappy/harness`/`@wappy/whatsapp` know nothing about it, and the
 * generated project's WhatsApp+harness wiring is already complete and self-sufficient without it
 * (see `tools.kind === "none"` in templates.ts). This module is the seam: `templates.ts` calls it
 * to EXTEND an otherwise-finished base project (extra import, extra setup lines, extra agent
 * fields, its own generated file, its own env vars) rather than having Shopify specifics
 * interleaved throughout the base rendering. Kept in this package for now (a deliberate, deferred
 * decision — see docs/PROGRESS.md), but this is the whole surface that would move if/when Shopify
 * becomes its own package (e.g. a future `@wappy/connector-shopify`): moving this one file plus its
 * skill wiring below is meant to be mechanical, not a rewrite.
 */

export interface ShopifyToolsSetup {
  importLine: string;
  /** A complete expression evaluating to a `ToolProvider`, used as-is at every call site. */
  providerExpr: string;
  envVars: EnvVarSpec[];
  fileName: string;
}

export function shopifyToolsSetup(tools: ToolsAnswer): ShopifyToolsSetup | undefined {
  if (tools.kind === "none") return undefined;
  return {
    importLine: 'import { createShopifyToolProvider } from "@wappy/tools-openapi";',
    // SHOPIFY_GRAPHQL_URL_OVERRIDE is undocumented-to-end-users on purpose (not in .env.sample): it
    // exists so this exact generated code can be pointed at a local mock Shopify server for
    // testing, without touching real store credentials. Real installs never set it.
    providerExpr:
      'createShopifyToolProvider({ storeDomain: process.env.SHOPIFY_STORE_DOMAIN!, accessTokenEnvVar: "SHOPIFY_ACCESS_TOKEN", graphqlUrlOverride: process.env.SHOPIFY_GRAPHQL_URL_OVERRIDE, ssrf: process.env.SHOPIFY_GRAPHQL_URL_OVERRIDE ? { allowPrivateNetworks: true } : undefined })',
    fileName: "shopify",
    envVars: [
      { name: "SHOPIFY_STORE_DOMAIN", required: true, group: "Shopify", description: 'Your store domain, e.g. "my-shop.myshopify.com".' },
      { name: "SHOPIFY_ACCESS_TOKEN", required: true, group: "Shopify", description: "Admin API access token: Shopify admin > Settings > Apps and sales channels > Develop apps > create a custom app, grant read scopes (products, orders, inventory, customers), install it, then copy the token." },
    ],
  };
}

/** Renders `tools/shopify.ts` — the one Shopify-specific generated FILE (separate from
 * `skills/*.ts`, which are generic tool-skills that happen to be backed by this provider, not
 * Shopify-specific themselves; see reference-skills.ts's own doc comment on that). */
export function renderShopifyToolsFile(tools: ToolsAnswer): GeneratedFile | undefined {
  const setup = shopifyToolsSetup(tools);
  if (!setup) return undefined;
  const lines: string[] = [setup.importLine, "", `export const toolProvider = ${setup.providerExpr};`, ""];
  return { path: `tools/${setup.fileName}.ts`, content: lines.join("\n") };
}
