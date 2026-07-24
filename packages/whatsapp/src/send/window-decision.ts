export type SendPathDecision = { kind: "freeform" } | { kind: "template"; templateName: string } | { kind: "queued"; reason: string };

export interface WindowDecisionInput {
  windowOpen: boolean;
  /** The template to fall back to when the window is closed, if the project configured a default one. */
  defaultTemplateName?: string;
}

/** Window-closed guard (§6.2): never silently drop — pick a template, or queue with an honest reason. */
export function decideSendPath(input: WindowDecisionInput): SendPathDecision {
  if (input.windowOpen) return { kind: "freeform" };
  if (input.defaultTemplateName) return { kind: "template", templateName: input.defaultTemplateName };
  return { kind: "queued", reason: "24h session window is closed and no fallback template is configured" };
}
