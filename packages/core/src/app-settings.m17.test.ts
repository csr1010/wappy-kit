import { describe, expect, test } from "vitest";
import { resolveSettings, staticAppDefinition, type WappyAppDefinition } from "./app-settings.js";
import type { WappyApp } from "./interfaces.js";

const def: WappyAppDefinition = {
  id: "demo",
  name: "Demo",
  version: "0.1.0",
  settings: [
    { key: "greeting", label: "Greeting", type: "text", default: "Hi!", maxLength: 20 },
    { key: "notes", label: "Notes", type: "longtext" },
    { key: "loud", label: "Loud", type: "boolean" },
    { key: "tone", label: "Tone", type: "select", options: ["warm", "brief"] },
  ],
  create: ({ settings }) => ({ id: "demo", name: "Demo", version: "0.1.0", description: String(settings.greeting) }),
};

describe("M17: app settings — declared by the app, resolved by the host", () => {
  test("nothing stored → every declared default (text '', boolean false, select's first option)", () => {
    expect(resolveSettings(def)).toEqual({ ok: true, settings: { greeting: "Hi!", notes: "", loud: false, tone: "warm" } });
  });

  test("stored values override defaults, and create() receives them", () => {
    const r = resolveSettings(def, { greeting: "Hello", loud: true, tone: "brief" });
    expect(r).toEqual({ ok: true, settings: { greeting: "Hello", notes: "", loud: true, tone: "brief" } });
    expect(r.ok && def.create({ settings: r.settings }).description).toBe("Hello");
  });

  test("bad values are all reported, none silently dropped", () => {
    const r = resolveSettings(def, { greeting: "x".repeat(21), loud: "yes", tone: "angry", notes: 5, extra: "?" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.sort()).toEqual([
      '"greeting" is longer than 20 characters',
      '"loud" must be true or false',
      '"notes" must be text',
      '"tone" must be one of: warm, brief',
      'unknown setting "extra"',
    ]);
  });

  test("a definition declaring the same key twice is rejected", () => {
    const twice = { settings: [{ key: "a", label: "A", type: "text" as const }, { key: "a", label: "A2", type: "boolean" as const }] };
    expect(resolveSettings(twice)).toMatchObject({ ok: false, errors: ['setting "a" is declared twice'] });
  });

  test("a select with no options and no default resolves to ''", () => {
    expect(resolveSettings({ settings: [{ key: "s", label: "S", type: "select", options: [] }] })).toEqual({ ok: true, settings: { s: "" } });
  });

  test("staticAppDefinition wraps a plain WappyApp: no settings, create() returns it as-is", () => {
    const app: WappyApp = { id: "echo", name: "Echo bot", version: "0.1.0", description: "Repeats" };
    const d = staticAppDefinition(app);
    expect({ id: d.id, name: d.name, version: d.version, description: d.description, settings: d.settings }).toEqual({ id: "echo", name: "Echo bot", version: "0.1.0", description: "Repeats", settings: [] });
    expect(d.create({ settings: {} })).toBe(app);
    expect(resolveSettings(d, {})).toEqual({ ok: true, settings: {} });
  });
});
