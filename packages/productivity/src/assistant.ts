import type { InboundMessage, JsonSchema, Model, Tool, ToolResult } from "@wappy_ai/core";

/**
 * v3 redesign — replaces the fixed-template/saved-task system entirely (direct feedback: "whatever
 * we are going to build it should work for anything that user might ask"). No saved tasks, no
 * templates, no matching step against a small fixed catalog: any inbound message that plausibly
 * needs real Gmail/Calendar data gets handed two generic, parameterized, READ-ONLY tools, and
 * `@wappy_ai/harness`'s `createVercelModel` already runs a full multi-step tool-calling loop
 * internally (via the Vercel AI SDK's own `stopWhen: stepCountIs(...)`) — it calls `execute()`,
 * feeds results back to the model, repeats until the model has what it needs, then returns one
 * final composed reply. This file just defines the two tools and decides whether this message
 * touched Gmail/Calendar at all (if not, it's not this assistant's concern — the normal reactive
 * agent handles it instead, unchanged).
 *
 * Deliberately read-only: no send/create/edit/delete tool exists for Gmail or Calendar. The system
 * preamble tells the model exactly that, and asks it to decline a write request warmly, not
 * defensively — "this is free open source software, feel free to add that yourself" in spirit, never
 * a canned refusal. There's nothing to "turn off" for CRUD — it was never built, which is the honest,
 * simple way to keep it out of scope for now.
 */

export interface GmailSearchArgs {
  /** Gmail's own search syntax, e.g. `"after:2026/09/27 before:2026/09/29 is:unread from:jane@x.com"`.
   * Omit for the default: unread inbox mail. */
  query?: string;
  /** Default 5, hard-capped at 10. */
  maxResults?: number;
}

export interface CalendarSearchArgs {
  /** ISO 8601 timestamps — both omitted defaults to the next 30 days from now. */
  timeMinISO?: string;
  timeMaxISO?: string;
  /** Calendar's own free-text search across title/description/location/attendees. */
  query?: string;
}

/** What a generated project's `index.ts` wires in — real implementations live in
 * `@wappy_ai/connector-google` (`createGmailSearchFn`/`createCalendarSearchFn`); this package never
 * imports that one (hub-and-spoke: productivity stays `@wappy_ai/core`-only), it just describes the
 * shape it expects. Omit either (or both) for a project with no Google connector wired in at all —
 * `maybeHandle` then never engages, same as before. */
export interface ConnectorContext {
  gmail?: (args: GmailSearchArgs) => Promise<string>;
  calendar?: (args: CalendarSearchArgs) => Promise<string>;
}

export interface CreateGoogleAssistantOptions {
  model: Model;
  connectors?: ConnectorContext;
  clock: { now(): number };
}

export interface AssistantResult {
  handled: boolean;
  reply?: string;
}

export interface GoogleAssistant {
  maybeHandle(message: InboundMessage): Promise<AssistantResult>;
}

const GMAIL_PARAMS: JsonSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: 'Gmail search syntax, e.g. "after:2026/09/27 before:2026/09/29 is:unread from:jane@example.com". Omit for the default: unread inbox mail.' },
    maxResults: { type: "number", description: "Max results to return. Default 5, hard-capped at 10." },
  },
};

const CALENDAR_PARAMS: JsonSchema = {
  type: "object",
  properties: {
    timeMinISO: { type: "string", description: "ISO 8601 start of the window, computed from the request and today's date." },
    timeMaxISO: { type: "string", description: "ISO 8601 end of the window. Both timeMinISO/timeMaxISO omitted defaults to the next 30 days." },
    query: { type: "string", description: "Free-text filter across event title/description/location/attendees." },
  },
};

function systemPreamble(nowISO: string): string {
  return [
    `Today's date and time: ${nowISO}.`,
    "You can READ the user's Gmail and Calendar through the tools available to you, and nothing else — there is no tool to send an email or create, edit, cancel, or delete anything; those don't exist here.",
    "If the request asks you to DO something rather than look something up, say so plainly and warmly, never defensively — this is free, open-source software, so it's fine to mention that adding that capability is something anyone (including the person asking) is welcome to contribute.",
    "If a request has multiple parts and you can only resolve some of them, say plainly what you found and what you didn't, rather than answering only part of it silently.",
    "Only call a tool when the request genuinely needs real Gmail/Calendar data — for anything else, don't call one.",
  ].join(" ");
}

/**
 * Real, generic Gmail/Calendar Q&A — no saved tasks, no fixed templates. `maybeHandle` returns
 * `handled: false` immediately whenever no connector is configured at all (Google never wired in for
 * this project) or the model decided the message didn't actually need Gmail/Calendar data, in which
 * case the caller should fall through to the normal reactive agent unchanged.
 */
export function createGoogleAssistant(opts: CreateGoogleAssistantOptions): GoogleAssistant {
  return {
    async maybeHandle(message) {
      const text = message.text?.trim();
      if (!text) return { handled: false };

      let usedAnyTool = false;
      const tools: Tool[] = [];

      if (opts.connectors?.gmail) {
        const gmailFn = opts.connectors.gmail;
        tools.push({
          name: "search_gmail",
          description: "Search the user's Gmail (read-only).",
          parameters: GMAIL_PARAMS,
          readOnly: true,
          confirmBefore: false,
          async execute(args): Promise<ToolResult> {
            usedAnyTool = true;
            try {
              const data = await gmailFn((args ?? {}) as GmailSearchArgs);
              return { toolName: "search_gmail", ok: true, data };
            } catch (e) {
              return { toolName: "search_gmail", ok: false, error: e instanceof Error ? e.message : String(e) };
            }
          },
        });
      }
      if (opts.connectors?.calendar) {
        const calendarFn = opts.connectors.calendar;
        tools.push({
          name: "search_calendar",
          description: "List/search the user's Calendar events (read-only).",
          parameters: CALENDAR_PARAMS,
          readOnly: true,
          confirmBefore: false,
          async execute(args): Promise<ToolResult> {
            usedAnyTool = true;
            try {
              const data = await calendarFn((args ?? {}) as CalendarSearchArgs);
              return { toolName: "search_calendar", ok: true, data };
            } catch (e) {
              return { toolName: "search_calendar", ok: false, error: e instanceof Error ? e.message : String(e) };
            }
          },
        });
      }

      if (tools.length === 0) return { handled: false }; // no Google connector wired in for this project at all

      let result;
      try {
        result = await opts.model.generate({ system: systemPreamble(new Date(opts.clock.now()).toISOString()), prompt: text, tools });
      } catch {
        // A routing hiccup should never block the normal agent from answering — but if a tool
        // already ran (and presumably had a side-effecting-adjacent cost, e.g. an API call), say so
        // rather than silently pretending nothing happened.
        return usedAnyTool ? { handled: true, reply: "Something went wrong partway through — try asking again in a moment." } : { handled: false };
      }

      if (!usedAnyTool) return { handled: false }; // the model itself decided this didn't need Gmail/Calendar

      const reply = result.text?.trim();
      return reply ? { handled: true, reply } : { handled: true, reply: "I looked but couldn't put together a reply — try asking again." };
    },
  };
}
