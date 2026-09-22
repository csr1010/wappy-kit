import { describe, expect, test } from "vitest";
import { createSkillRegistry } from "./skills.js";
import { createProductsSkill, DEFAULT_PRODUCTS_SKILL_TOOLS } from "./reference-skills.js";

// A new file, not an edit to reference-skills.m8.test.ts — B2 (the milestone loop's own rule)
// treats even an addition to an already-tagged test file as a modification, so a genuinely new
// skill's tests get their own file. Found by hand-testing a real conversation: connecting Shopify
// only shipped `store-info` (RAG) and `orders` (order-status tools), so "show me your products"
// was correctly declined — no skill ever told the agent it could browse the catalog, even though
// the Shopify connector's searchProducts/getProduct/getInventoryLevels tools already existed.

describe("reference skills — products", () => {
  test("defaults to the Shopify connector's own catalog/stock tool names", () => {
    const skill = createProductsSkill();
    expect(skill.name).toBe("products");
    expect(skill.tools).toEqual(DEFAULT_PRODUCTS_SKILL_TOOLS);
    expect(skill.tools).toEqual(["searchProducts", "getProduct", "getInventoryLevels"]);
  });

  test("does NOT touch order tools — orders and products are independently wireable", () => {
    const skill = createProductsSkill();
    expect(skill.tools).not.toContain("getOrder");
    expect(skill.tools).not.toContain("listRecentOrders");
  });

  test("tool names are overridable for a non-Shopify catalog provider", () => {
    const skill = createProductsSkill({ toolNames: ["catalogSearch"] });
    expect(skill.tools).toEqual(["catalogSearch"]);
  });

  test("prompt fragment steers toward a WhatsApp list for multiple results, and against fabrication", () => {
    const skill = createProductsSkill();
    const p = skill.promptFragment.toLowerCase();
    expect(p).toContain("list message");
    expect(p).toContain("never invent");
  });

  test("registers cleanly in a SkillRegistry and is discoverable by name", () => {
    const registry = createSkillRegistry();
    const skill = createProductsSkill();
    registry.register(skill);
    expect(registry.get("products")).toBe(skill);
    expect(registry.names()).toContain("products");
  });
});
