/**
 * The 5 pre-built task templates (Phase 1, plan's "pick-from-list, inline-editable placeholders,
 * not free-form authoring" decision). Pure data — no execution logic here; `actions.ts` (reminder/
 * wake-me-up, Phase 3) and `@wappy_ai/connector-google` (the other 3, Phase 6) provide the behavior
 * behind each id. Kept here, not duplicated, so the UI (Phase 4) and the runner (Phase 2) always
 * agree on what a template actually looks like.
 */

export type TemplateId = "reminder" | "wake_me_up" | "daily_meetings" | "summarize_emails" | "find_emails";

export type ScheduleKind = "dailyAt" | "once";

export interface PlaceholderField {
  /** Matches a key in a task's `placeholders` JSON blob. */
  key: string;
  label: string;
  /** "text" is a free-form string (a reminder body, a search query); "time" is "HH:MM". */
  kind: "text" | "time";
}

export interface TaskTemplate {
  id: TemplateId;
  label: string;
  icon: string;
  placeholders: PlaceholderField[];
  /** The fill-in-the-blank sentence the UI (Phase 4) renders directly, inline-editable — `{key}`
   * tokens mark where each `placeholders` entry's input goes. E.g. "Remind me about {text} at
   * {time}" becomes "Remind me about [____] at [__:__]" with real, always-visible inputs, not a
   * popup prompt. Says "every day" explicitly, not just "at {time}" — a bare time is ambiguous
   * about whether it recurs (every template here defaults to `dailyAt`, so it should read that way).
   * One source of truth for both the task list page and (later) any other renderer. */
  sentence: string;
  defaultScheduleKind: ScheduleKind;
  /** Whether someone would plausibly want more than one of these at once. A wake-up alarm or a
   * meetings/email digest is naturally one thing you have (or don't); a reminder or a saved email
   * search is naturally something you'd want several distinct ones of ("call mom," "pay rent," each
   * its own). Drives the task list's UI (Phase 4): `false` shows one persistent slot per contact;
   * `true` always offers one more "add another" slot after the last one. */
  repeatable: boolean;
  /** Whether this template can fully run today (Phase 3) or is an honest stub until Phase 6 wires
   * a real Google connector action in. Purely informational for the UI's warning banner (Phase 4) —
   * it never gates whether a task can be created, only whether it does something real yet. */
  requiresGoogle: boolean;
}

export const TASK_TEMPLATES: readonly TaskTemplate[] = [
  {
    id: "reminder",
    label: "Remind me about",
    icon: "⏰",
    placeholders: [
      { key: "text", label: "What should I remind you about?", kind: "text" },
      { key: "time", label: "At", kind: "time" },
    ],
    sentence: "Remind me about {text}, every day at {time}",
    defaultScheduleKind: "dailyAt",
    repeatable: true,
    requiresGoogle: false,
  },
  {
    id: "wake_me_up",
    label: "Wake me up",
    icon: "☀️",
    placeholders: [{ key: "time", label: "At", kind: "time" }],
    sentence: "Wake me up every day at {time}",
    defaultScheduleKind: "dailyAt",
    repeatable: false,
    requiresGoogle: false,
  },
  {
    id: "daily_meetings",
    label: "Send tomorrow's meetings",
    icon: "🗓️",
    placeholders: [{ key: "time", label: "At", kind: "time" }],
    sentence: "Send me tomorrow's meetings, every day at {time}",
    defaultScheduleKind: "dailyAt",
    repeatable: false,
    requiresGoogle: true,
  },
  {
    id: "summarize_emails",
    label: "Summarize my unread emails",
    icon: "📧",
    // "Summarize my emails at 9am" doesn't say WHICH emails — clarified in the sentence to match
    // what the real action actually does (connector-google's summarizeEmails: unread inbox mail),
    // not a new placeholder — the scope was already real, just unstated in the UI (real feedback).
    placeholders: [{ key: "time", label: "At", kind: "time" }],
    sentence: "Summarize my unread emails, every day at {time}",
    defaultScheduleKind: "dailyAt",
    repeatable: false,
    requiresGoogle: true,
  },
  {
    id: "find_emails",
    label: "Find emails about",
    icon: "🔎",
    placeholders: [
      { key: "query", label: "Search for", kind: "text" },
      { key: "time", label: "At", kind: "time" },
    ],
    sentence: "Find emails about {query}, every day at {time}",
    defaultScheduleKind: "dailyAt",
    repeatable: true,
    requiresGoogle: true,
  },
] as const;

export function templateById(id: TemplateId): TaskTemplate {
  const found = TASK_TEMPLATES.find((t) => t.id === id);
  if (!found) throw new Error(`templateById: unknown template id "${id}"`);
  return found;
}
