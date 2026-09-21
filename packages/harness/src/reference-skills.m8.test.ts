import { describe, expect, test } from "vitest";
import { createSkillRegistry } from "./skills.js";
import { createOrdersSkill, DEFAULT_ORDERS_SKILL_TOOLS, STORE_INFO_SKILL } from "./reference-skills.js";

describe("reference skills — store-info", () => {
  test("is a pure-RAG skill: no tools, a prompt fragment that grounds answers in retrieved info", () => {
    expect(STORE_INFO_SKILL.name).toBe("store-info");
    expect(STORE_INFO_SKILL.tools).toBeUndefined();
    expect(STORE_INFO_SKILL.promptFragment.toLowerCase()).toContain("retrieved");
  });

  test("registers cleanly in a SkillRegistry and is discoverable by name", () => {
    const registry = createSkillRegistry();
    registry.register(STORE_INFO_SKILL);
    expect(registry.get("store-info")).toBe(STORE_INFO_SKILL);
    expect(registry.names()).toContain("store-info");
  });
});

describe("reference skills — orders", () => {
  test("defaults to the Shopify connector's own order tool names", () => {
    const skill = createOrdersSkill();
    expect(skill.tools).toEqual(DEFAULT_ORDERS_SKILL_TOOLS);
    expect(skill.tools).toEqual(["getOrder", "listRecentOrders"]);
  });

  test("tool names are overridable for a non-Shopify order provider", () => {
    const skill = createOrdersSkill({ toolNames: ["fetchOrderStatus"] });
    expect(skill.tools).toEqual(["fetchOrderStatus"]);
  });

  test("prompt fragment instructs honesty on tool failure and against fabrication", () => {
    const skill = createOrdersSkill();
    expect(skill.promptFragment.toLowerCase()).toContain("never fabricate");
    expect(skill.promptFragment.toLowerCase()).toContain("failed");
  });

  test("declares a documentation-only memorySchema (core doesn't enforce it)", () => {
    const skill = createOrdersSkill();
    expect(skill.memorySchema).toBeDefined();
  });

  test("registers cleanly alongside store-info without name collision", () => {
    const registry = createSkillRegistry();
    registry.register(STORE_INFO_SKILL);
    registry.register(createOrdersSkill());
    expect(registry.names().sort()).toEqual(["orders", "store-info"]);
  });
});
