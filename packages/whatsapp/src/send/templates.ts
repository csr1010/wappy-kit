import type { CloudApiOutboundPayload } from "./render.js";

export interface TemplateButtonDef {
  type: "quick_reply" | "url";
  text: string;
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

  const missing = def.variables.filter((v) => !(v in variables));
  if (missing.length > 0) return { ok: false, error: `template "${name}" is missing variables: ${missing.join(", ")}` };

  const components: Record<string, unknown>[] = [
    { type: "body", parameters: def.variables.map((v) => ({ type: "text", text: variables[v] })) },
  ];
  // A button's dynamic value: the payload returned in the click webhook for quick_reply, or the
  // {{1}} URL-suffix text for url (§6.1 "variable + button mapping"). Meta's own approved template
  // already fixes each button's static label/URL — this component only supplies the per-send part.
  for (const [index, button] of (def.buttons ?? []).entries()) {
    components.push({
      type: "button",
      sub_type: button.type,
      index: String(index),
      parameters: [button.type === "quick_reply" ? { type: "payload", payload: button.text } : { type: "text", text: button.text }],
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
