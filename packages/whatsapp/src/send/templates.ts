import type { CloudApiOutboundPayload } from "./render.js";

export interface TemplateButtonDef {
  type: "quick_reply" | "url";
  /** Static fallback value (the payload for quick_reply, or the {{1}} URL-suffix text for url) used when `variable` is unset. */
  text: string;
  /** Name of a per-send variable (looked up in the same `variables` record passed to renderTemplate,
   * alongside the body's) supplying this button's dynamic value instead of the static `text`. */
  variable?: string;
}

export interface TemplateDef {
  name: string;
  language: string;
  category: "utility" | "marketing" | "authentication";
  /** Ordered body variable names — position N maps to the template's {{N}} placeholder. */
  variables: string[];
  buttons?: TemplateButtonDef[];
}

/** Registry of Meta-approved templates a project has configured (§6.1 "Templates: registry + variable mapping"). */
export interface TemplateRegistry {
  register(def: TemplateDef): void;
  get(name: string): TemplateDef | undefined;
}

export function createTemplateRegistry(): TemplateRegistry {
  const templates = new Map<string, TemplateDef>();
  return {
    register(def) {
      if (templates.has(def.name)) throw new Error(`template "${def.name}" is already registered`);
      templates.set(def.name, def);
    },
    get: (name) => templates.get(name),
  };
}

export type TemplateRenderResult = { ok: true; payload: CloudApiOutboundPayload } | { ok: false; error: string };

export function renderTemplate(registry: TemplateRegistry, to: string, name: string, variables: Record<string, string>): TemplateRenderResult {
  const def = registry.get(name);
  if (!def) return { ok: false, error: `template "${name}" is not registered` };

  const buttonVariables = (def.buttons ?? []).map((b) => b.variable).filter((v): v is string => v !== undefined);
  const missing = [...new Set([...def.variables, ...buttonVariables])].filter((v) => !(v in variables));
  if (missing.length > 0) return { ok: false, error: `template "${name}" is missing variables: ${missing.join(", ")}` };

  const components: Record<string, unknown>[] = [
    { type: "body", parameters: def.variables.map((v) => ({ type: "text", text: variables[v] })) },
  ];
  // A button's dynamic value: the payload returned in the click webhook for quick_reply, or the
  // {{1}} URL-suffix text for url (§6.1 "variable + button mapping"). Meta's own approved template
  // already fixes each button's static label/URL — this component only supplies the per-send part,
  // resolved from `variables` by name (same as the body) when `variable` is set, else `text` as a
  // fixed fallback for a button whose value genuinely never changes between sends.
  for (const [index, button] of (def.buttons ?? []).entries()) {
    const value = button.variable !== undefined ? variables[button.variable] : button.text;
    components.push({
      type: "button",
      sub_type: button.type,
      index: String(index),
      parameters: [button.type === "quick_reply" ? { type: "payload", payload: value } : { type: "text", text: value }],
    });
  }

  return {
    ok: true,
    payload: {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: def.name,
        language: { code: def.language },
        components,
      },
    },
  };
}
