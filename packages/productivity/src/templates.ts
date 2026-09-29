/**
 * The 4 pre-built task templates (v2 redesign — dropped cron scheduling and WhatsApp Message
 * Templates entirely, per direct feedback: "we should not setup cron or templates at this point
 * especially for free open source projects thats too much"). A task is now reactive, not proactive:
 * nothing pushes on a timer. Instead, `router.ts` matches an inbound chat message against the
 * contact's saved tasks and, on a match, runs that template's fixed `instructions` prompt against
 * fresh Gmail/Calendar data. Because every reply is a response to an inbound message, it's always
 * inside WhatsApp's 24h session window — no Message Template is ever needed.
 *
 * The prompt text itself (`instructions`) is intentionally NOT user-editable — only a single
 * optional filter placeholder is ("we don't let users write the task... what they can edit is like
 * placeholders"). Left blank, each template falls back to a sensible default (top 5 unread emails,
 * "today", the 5 nearest upcoming events, etc.) — never a bare unfiltered dump, never a required
 * field blocking task creation.
 */

export type TemplateId = "summarize_emails" | "find_emails" | "daily_meetings" | "find_events";

export interface PlaceholderField {
  /** Matches the key in a task's `placeholders` JSON blob. */
  key: string;
  label: string;
  /** Shown in the input when empty — states the default, not just "optional", so it's obvious what
   * happens if the person leaves it blank. */
  placeholderHint: string;
}

export interface TaskTemplate {
  id: TemplateId;
  label: string;
  icon: string;
  /** 0 or 1 field — kept to one so the UI's fill-in-the-blank sentence never gets more than one
   * blank per template ("keep it extremely simple"). */
  placeholders: PlaceholderField[];
  /** The fill-in-the-blank sentence the UI renders inline-editable — `{key}` marks where the one
   * placeholder's input goes, same mechanism as before, just with no `{time}`/schedule token now. */
  sentence: string;
  /** Which connector this template needs data from — drives which one(s) `router.ts` fetches before
   * composing a reply. Both templates about email need `gmail`; both about the calendar need
   * `calendar`. */
  connector: "gmail" | "calendar";
  /** Whether someone would plausibly want more than one of these (different filter values) at once
   * — "find emails about invoices" and "find emails about travel" are both reasonable to keep
   * around; "summarize my unread emails" isn't something you'd want two differently-configured
   * copies of. Drives the task list UI: `false` shows one persistent slot; `true` always offers one
   * more "add another" slot after the last one. */
  repeatable: boolean;
  /** The literal instruction text sent to the model once a task matches an inbound message — fixed,
   * never user-authored. `{key}` tokens are filled from the task's `placeholders` (or the default
   * text below when blank) by `buildInstructions()`. */
  instructionsTemplate: string;
  /** Per-placeholder-key default substituted into `instructionsTemplate` when that field is blank. */
  defaults: Record<string, string>;
}

export const TASK_TEMPLATES: readonly TaskTemplate[] = [
  {
    id: "summarize_emails",
    label: "Summarize my unread emails",
    icon: "📧",
    placeholders: [{ key: "from", label: "From", placeholderHint: "anyone" }],
    sentence: "Summarize my unread emails from {from}",
    connector: "gmail",
    repeatable: false,
    instructionsTemplate: "Summarize the user's unread emails{from}. List at most 5, most recent first. If there are none matching, say so plainly instead of inventing any.",
    defaults: { from: "" },
  },
  {
    id: "find_emails",
    label: "Find emails about",
    icon: "🔎",
    placeholders: [{ key: "query", label: "About", placeholderHint: "your most recent emails" }],
    sentence: "Find emails about {query}",
    connector: "gmail",
    repeatable: true,
    instructionsTemplate: "Find emails{query}. List at most 5 matches, most recent first, with sender and a one-line summary each. If there are none matching, say so plainly instead of inventing any.",
    defaults: { query: "" },
  },
  {
    id: "daily_meetings",
    label: "Send me my meetings",
    icon: "🗓️",
    placeholders: [{ key: "when", label: "For", placeholderHint: "today" }],
    sentence: "Send me my meetings for {when}",
    connector: "calendar",
    repeatable: false,
    instructionsTemplate: "List the user's meetings/events for {when}, with times, most recent first. If there are none, say so plainly instead of inventing any.",
    defaults: { when: "today" },
  },
  {
    id: "find_events",
    label: "Find events about",
    icon: "📅",
    placeholders: [{ key: "query", label: "About", placeholderHint: "your next 5 upcoming events" }],
    sentence: "Find events about {query}",
    connector: "calendar",
    repeatable: true,
    instructionsTemplate: "Find calendar events{query}. List at most 5 matches, soonest first, with the date/time. If there are none matching, say so plainly instead of inventing any.",
    defaults: { query: "" },
  },
] as const;

export function templateById(id: TemplateId): TaskTemplate {
  const found = TASK_TEMPLATES.find((t) => t.id === id);
  if (!found) throw new Error(`templateById: unknown template id "${id}"`);
  return found;
}

/** Fills a template's `instructionsTemplate` with a task's actual placeholder values, falling back
 * to the template's own default text for anything left blank — the one place "what happens if they
 * don't enter anything" is decided. `{from}`/`{query}`/`{when}` each render as a short clause (e.g.
 * `{from}` -> " from jane@example.com" or "" when blank/default), everything else passes through. */
export function buildInstructions(template: TaskTemplate, placeholders: Record<string, string>): string {
  let text = template.instructionsTemplate;
  for (const field of template.placeholders) {
    const raw = placeholders[field.key]?.trim();
    const value = raw || template.defaults[field.key] || "";
    let clause = "";
    if (field.key === "from" && value) clause = ` from ${value}`;
    else if (field.key === "query" && value) clause = ` about ${value}`;
    else if (field.key === "when") clause = ` for ${value || "today"}`;
    text = text.replaceAll(`{${field.key}}`, clause);
  }
  return text;
}
