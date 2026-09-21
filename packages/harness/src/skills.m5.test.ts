import { describe, expect, test } from "vitest";
import type { Skill } from "@wappy/core";
import { createSkillRegistry } from "./skills.js";

const storeInfo: Skill = { name: "store-info", description: "answers store questions", promptFragment: "You know the store's hours and location.", tools: ["getStoreHours"] };
const orders: Skill = { name: "orders", description: "looks up orders", promptFragment: "You can look up order status by id.", tools: ["getOrder"], memorySchema: { lastOrderId: "" } };

describe("createSkillRegistry", () => {
  test("register + get round-trips", () => {
    const registry = createSkillRegistry();
    registry.register(storeInfo);
    expect(registry.get("store-info")).toBe(storeInfo);
  });

  test("get() on an unregistered name returns undefined", () => {
    expect(createSkillRegistry().get("nope")).toBeUndefined();
  });

  test("list() returns every registered skill, in registration order", () => {
    const registry = createSkillRegistry();
    registry.register(storeInfo);
    registry.register(orders);
    expect(registry.list()).toEqual([storeInfo, orders]);
  });

  test("list() on an empty registry returns an empty array", () => {
    expect(createSkillRegistry().list()).toEqual([]);
  });

  test("registering the same name twice throws", () => {
    const registry = createSkillRegistry();
    registry.register(storeInfo);
    expect(() => registry.register(storeInfo)).toThrow(/already registered/i);
  });

  test("names() is what a caller hands the Router as availableSkills", () => {
    const registry = createSkillRegistry();
    registry.register(storeInfo);
    registry.register(orders);
    expect(registry.names()).toEqual(["store-info", "orders"]);
  });
});
