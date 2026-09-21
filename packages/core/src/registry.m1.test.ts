import { describe, expect, test } from "vitest";
import { PluginRegistry, resolveEnabledPlugins, type Plugin } from "./registry.js";
import { satisfiesRange } from "./semver.js";

const plugin = (over: Partial<Plugin> = {}): Plugin => ({
  name: "whatsapp",
  kind: "channel",
  coreVersionRange: "^1.0.0",
  instance: { hi: true },
  ...over,
});

describe("PluginRegistry", () => {
  test("register + get round-trips the instance", () => {
    const r = new PluginRegistry("1.2.3");
    r.register(plugin());
    expect(r.get("channel")).toEqual({ hi: true });
  });

  test("rejects duplicate names", () => {
    const r = new PluginRegistry("1.0.0");
    r.register(plugin());
    expect(() => r.register(plugin())).toThrow(/duplicate/i);
  });

  test("rejects version skew", () => {
    const r = new PluginRegistry("2.0.0");
    expect(() => r.register(plugin({ coreVersionRange: "^1.0.0" }))).toThrow(/requires core/i);
  });

  test("deterministic ordering = registration order", () => {
    const r = new PluginRegistry("1.0.0");
    r.register(plugin({ name: "a", kind: "skill" }));
    r.register(plugin({ name: "b", kind: "skill" }));
    r.register(plugin({ name: "c", kind: "skill" }));
    expect(r.list("skill").map((p) => p.name)).toEqual(["a", "b", "c"]);
  });

  test("get() on an unregistered kind returns undefined, not throw", () => {
    const r = new PluginRegistry("1.0.0");
    expect(r.get("memory")).toBeUndefined();
  });

  test("get() by name picks a specific plugin among several of the same kind", () => {
    const r = new PluginRegistry("1.0.0");
    r.register(plugin({ name: "a", kind: "skill", instance: 1 }));
    r.register(plugin({ name: "b", kind: "skill", instance: 2 }));
    expect(r.get("skill", "b")).toBe(2);
  });
});

describe("resolveEnabledPlugins", () => {
  test("resolves in config order", () => {
    const r = new PluginRegistry("1.0.0");
    r.register(plugin({ name: "a", kind: "skill" }));
    r.register(plugin({ name: "b", kind: "skill" }));
    const enabled = resolveEnabledPlugins(r, { enabled: ["b", "a"] });
    expect(enabled.map((p) => p.name)).toEqual(["b", "a"]);
  });

  test("throws on an unknown plugin name", () => {
    const r = new PluginRegistry("1.0.0");
    expect(() => resolveEnabledPlugins(r, { enabled: ["nope"] })).toThrow(/unknown plugin/i);
  });
});

describe("satisfiesRange", () => {
  test.each([
    ["1.2.3", "*", true],
    ["1.2.3", "1.2.3", true],
    ["1.2.4", "1.2.3", false],
    ["1.3.0", "^1.2.3", true],
    ["2.0.0", "^1.2.3", false],
    ["1.2.2", "^1.2.3", false],
    ["1.2.9", "~1.2.3", true],
    ["1.3.0", "~1.2.3", false],
    ["0.2.5", "^0.2.3", true],
    ["0.3.0", "^0.2.3", false],
  ])("satisfiesRange(%s, %s) === %s", (version, range, expected) => {
    expect(satisfiesRange(version, range)).toBe(expected);
  });
});
