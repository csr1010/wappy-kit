import type { WappyApp } from "./interfaces.js";

/**
 * M17: settings an app declares, so a host can store them, show a form for them, and create the
 * app from them. Plain data (no schema library): a host renders the form from these fields and
 * validates stored values with `resolveSettings` before handing them to `create()`.
 */
interface FieldBase {
  /** Stable key, unique within the app (e.g. "linksReply"). */
  key: string;
  label: string;
  /** One line shown under the field in a settings form. */
  help?: string;
}
export type AppSettingField =
  | (FieldBase & { type: "text" | "longtext"; default?: string; maxLength?: number })
  | (FieldBase & { type: "boolean"; default?: boolean })
  | (FieldBase & { type: "select"; options: string[]; default?: string });

export type AppSettingValue = string | boolean;
export type AppSettings = Record<string, AppSettingValue>;

/**
 * An app as a host installs it: what it is, which settings it takes, and how to create it from
 * resolved settings. `create` runs per owner (and again whenever their settings change), so it
 * should be cheap and side-effect free.
 */
export interface WappyAppDefinition {
  id: string;
  name: string;
  version: string;
  description?: string;
  settings?: AppSettingField[];
  create(ctx: { settings: AppSettings }): WappyApp;
}

/** Wraps an app that takes no settings (e.g. a plain `WappyApp` export) as a definition. */
export function staticAppDefinition(app: WappyApp): WappyAppDefinition {
  return { id: app.id, name: app.name, version: app.version, description: app.description, settings: [], create: () => app };
}

export type ResolvedSettings = { ok: true; settings: AppSettings } | { ok: false; errors: string[] };

function defaultFor(field: AppSettingField): AppSettingValue {
  if (field.type === "boolean") return field.default ?? false;
  if (field.type === "select") return field.default ?? field.options[0] ?? "";
  return field.default ?? "";
}

/**
 * Stored values merged over the declared defaults. Rejects (never silently drops) unknown keys,
 * wrong types, select values outside `options`, and text over `maxLength`, so a bad save is
 * reported to whoever made it instead of quietly changing what the agent says.
 */
export function resolveSettings(definition: Pick<WappyAppDefinition, "settings">, stored: Record<string, unknown> = {}): ResolvedSettings {
  const fields = definition.settings ?? [];
  const errors: string[] = [];
  const byKey = new Map<string, AppSettingField>();
  for (const f of fields) {
    if (byKey.has(f.key)) errors.push(`setting "${f.key}" is declared twice`);
    byKey.set(f.key, f);
  }
  for (const key of Object.keys(stored)) if (!byKey.has(key)) errors.push(`unknown setting "${key}"`);

  const settings: AppSettings = {};
  for (const f of byKey.values()) {
    const raw = stored[f.key];
    if (raw === undefined) {
      settings[f.key] = defaultFor(f);
      continue;
    }
    if (f.type === "boolean") {
      if (typeof raw !== "boolean") errors.push(`"${f.key}" must be true or false`);
      else settings[f.key] = raw;
      continue;
    }
    if (typeof raw !== "string") {
      errors.push(`"${f.key}" must be text`);
      continue;
    }
    if (f.type === "select" && !f.options.includes(raw)) errors.push(`"${f.key}" must be one of: ${f.options.join(", ")}`);
    else if (f.type !== "select" && f.maxLength !== undefined && raw.length > f.maxLength) errors.push(`"${f.key}" is longer than ${f.maxLength} characters`);
    else settings[f.key] = raw;
  }
  return errors.length ? { ok: false, errors } : { ok: true, settings };
}
