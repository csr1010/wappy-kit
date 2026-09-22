import { describe, expect, test } from "vitest";
import { renderShopifyToolsFile, shopifyToolsSetup } from "./shopify.js";

// Guards the module boundary itself: everything Shopify-specific in create-wappy lives here, not
// interleaved through templates.ts, so a future extraction (e.g. to @wappy/connector-shopify) can
// move this one file rather than untangle it from generic harness/whatsapp rendering (see this
// file's own header comment, and docs/PROGRESS.md's deferred connector-marketplace decision).

describe("shopifyToolsSetup", () => {
  test("tools.kind: none -> undefined (no Shopify wiring at all)", () => {
    expect(shopifyToolsSetup({ kind: "none" })).toBeUndefined();
  });

  test("tools.kind: shopify -> real provider wiring + its own two required env vars", () => {
    const setup = shopifyToolsSetup({ kind: "shopify" })!;
    expect(setup.importLine).toContain("createShopifyToolProvider");
    expect(setup.providerExpr).toContain("SHOPIFY_STORE_DOMAIN");
    expect(setup.envVars.map((v) => v.name)).toEqual(["SHOPIFY_STORE_DOMAIN", "SHOPIFY_ACCESS_TOKEN"]);
    expect(setup.fileName).toBe("shopify");
  });
});

describe("renderShopifyToolsFile", () => {
  test("no store connected -> no file", () => {
    expect(renderShopifyToolsFile({ kind: "none" })).toBeUndefined();
  });

  test("shopify connected -> tools/shopify.ts, self-contained (imports what it uses)", () => {
    const file = renderShopifyToolsFile({ kind: "shopify" })!;
    expect(file.path).toBe("tools/shopify.ts");
    expect(file.content).toContain('import { createShopifyToolProvider } from "@wappy/tools-openapi";');
    expect(file.content).toContain("export const toolProvider =");
  });
});
