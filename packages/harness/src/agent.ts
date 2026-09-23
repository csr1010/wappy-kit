import type { Agent, Clock, DeliveryResult, InboundMessage, MessageChannel, Memory, Model, Router, RouterDecision, SessionProfile, SessionProfileStore, SmartMessage, TracedSystem, Tool, Tracer, Turn } from "@wappy/core";
import { boundInboundText, DEFAULT_INBOUND_TEXT_LIMITS, type InboundTextLimits } from "./bound-inbound-text.js";
import { composeWithBudget } from "./compose-with-budget.js";
import { createContextBudget, type ContextBudget } from "./context-budget.js";
import { windowHistory } from "./history-window.js";
import { selectTools } from "./tool-selector.js";
import { TOOL_SCHEMAS_BUDGET_FRACTION } from "./assemble.js";
import type { SkillRegistry } from "./skills.js";
import { CANCEL_ACTION, parseConfirmSelection, type ConfirmFlow, type ParsedConfirmSelection } from "./confirm.js";

const SCOPE_GUARDRAIL = "If the user's request is genuinely unrelated to what you're configured to help with, say so honestly and directly rather than guessing or making something up.";

/** M12: replaces every per-skill format hint that used to be hand-authored per domain (e.g. a
 * products skill saying "prefer a list for multiple items"). One fixed instruction, zero domain
 * language, applies to every reply regardless of what connector or skill produced the content —
 * a cognitive question series, not a flat command, per the design this milestone settled on.
 * Runs on every compose call, including the cheapest path ("hi") — a deliberate trade against the
 * router's own cheapest-path principle, made explicitly, not by accident. */
export const FORMAT_REASONING = `Before you reply, work through these questions about how to present it, not just what to say:
1. What formats can I actually use? Plain text. Up to 3 quick-reply buttons. A list of up to 10 options. A single link as a tappable button. An image, video, or document, optionally paired with buttons or a list.
2. Does this reply have 2 or more distinct things the person could choose between? If yes, a list or buttons let them tap instead of type.
3. Is there exactly one clear next action, like opening a link? A tappable link button beats a raw URL in text.
4. Would an image, video, or document actually help here? If yes, attach it — pair it with buttons or a list too if you're also offering a choice.
5. Is this just a short, conversational answer with nothing to structure? Plain text is correct then. Don't force structure onto it.
6. Given all that, which single format fits best, and why? State that reason in formatRationale, specific to this exact reply, not a generic justification you'd give for any reply.`;

/** M12: the single, generic honesty rule that replaced three near-identical, hand-written
 * sentences (store-info/orders/products' own skill fragments each said this in different words). */
export const GROUNDING_HONESTY =
  "Only state what a tool call or retrieved document actually returned. Never invent a detail, a value, or a status that wasn't actually provided. If nothing relevant was found, or a tool call failed, say so honestly rather than guessing.";

const REFUSAL_TEXT = "That message is too long for me to process — could you send it as a shorter message?";
const OVERSIZED_PLACEHOLDER = "(the user sent a message too large to process)";
const NOTHING_PENDING_TEXT = "There's nothing pending to confirm right now.";
const STALE_CONFIRMATION_TEXT = "That confirmation isn't valid anymore — please ask again.";
const CONFIRM_TOOL_UNAVAILABLE_TEXT = "Sorry, I couldn't complete that — please try again, or our team will follow up.";

/** Used when the caller doesn't supply one — a conservative, safe-by-default budget (§10 T6.1). */
const DEFAULT_CONTEXT_BUDGET: ContextBudget = createContextBudget("unrecognized");
const DEFAULT_MAX_RECENT_TURNS = 20;
/** M13: session profile TTL — renewed on every successful turn (a plain `set()`, no separate
 * "touch" verb). 30 minutes of inactivity resets the session to empty, matching the design's own
 * "session-scoped, not a permanent user profile" boundary (docs/milestones/M13.md). */
const DEFAULT_SESSION_PROFILE_TTL_MS = 30 * 60 * 1000;

/** TracedSystem values a MessageChannel is allowed to be traced under — deliberately closed (not
 * `channel.name` verbatim) so a customized channel name can't inject an out-of-union label into
 * `tracer.touched()`/`events()`. */
const KNOWN_TRACED_CHANNELS: ReadonlySet<string> = new Set<TracedSystem>(["whatsapp"]);

export interface AgentDeps {
  channel: MessageChannel;
  memory: Memory;
  router: Router;
  model: Model;
  clock: Clock;
  tracer: Tracer;
  skills?: SkillRegistry;
  /** M13: session profile (facts + current open thread + a coarser summary), TTL-bound. Unset =
   * feature off entirely, fully backward compatible — nothing is read or written. When set, read
   * at the very start of `handle()` alongside `memory.load()`, and written after a successful send. */
  sessionProfileStore?: SessionProfileStore;
  /** How long a session profile survives inactivity before a fresh session starts with nothing
   * carried over. Default 30 minutes. */
  sessionProfileTtlMs?: number;
  /** RAG hook — default: no-op (no extra context). Real implementation (§9 Scenario B): `knowledge.ts`'s `createKnowledgeRag()` (M8). */
  retrieveRag?: (input: { contactId: string; query: string }) => Promise<string[]>;
  /** Tool-invocation hook — default: no-op (no findings). Real implementation (§9 Scenario C): `invoke-tools.ts`'s `createToolInvoker()` (M8). */
  invokeTools?: (input: { message: InboundMessage; decision: RouterDecision }) => Promise<string[]>;
  /** Pool available for runtime BM25 selection (T6.5) when a message needsTool — declaring available
   * tools to the model (for the prompt's textual tool-schema disclosure) is separate from actually
   * invoking one (that's `invokeTools`, e.g. `createToolInvoker({tools, ...})` using this same pool). Default []. */
  tools?: Tool[];
  /** Confirm-before-write flow (§8/§9 T8.5) — when set, an inbound message carrying
   * `selectionId: "confirm"`/`"cancel"` is intercepted HERE, before routing, and resolves the
   * contact's pending confirmation (executing the held tool call exactly once, or discarding it)
   * instead of going through the normal skill/RAG/tool/compose pipeline. Requesting a confirmation
   * in the first place is `createToolInvoker`'s job (via this same flow, passed to it separately) —
   * this dependency is what RESOLVES one once the user replies. Default: confirm/cancel selection
   * ids are treated as ordinary messages (no interception) when unset. */
  confirmFlow?: ConfirmFlow;
  /** Bounds the whole assembled prompt (T6.1/T6.2); default is a conservative, model-agnostic budget. */
  contextBudget?: ContextBudget;
  /** Turns kept verbatim in the prompt; older history is summarized (T6.3). Default 20. */
  maxRecentTurns?: number;
  /** Below this, skill/RAG/tool augmentation is suppressed but a reply is still always sent (§9 confidence gate). Default 0.3. */
  confidenceThreshold?: number;
  onEscalate?: (message: InboundMessage, decision: RouterDecision) => void | Promise<void>;
  /** Id for the agent's own reply Turn to a given inbound message — MUST be deterministic per
   * `message.id` (and unique across contacts), since it's also the idempotency marker a replay is
   * checked against. Default: `${message.id}:reply`. */
  idGenerator?: (message: InboundMessage) => string;
  /** Thresholds for an oversized inbound message.text (§10) — truncated with a notice below
   * `refuseChars`, politely declined (no routing/compose, still exactly one reply) above it. */
  inboundTextLimits?: InboundTextLimits;
}

/**
 * Orchestrates one inbound message -> reply: load memory -> route -> (skill/RAG/tool) -> compose ->
 * confidence gate -> send -> persist -> trace, each step degrading rather than crashing (§9, §10).
 * Per-contact serialized so two rapid messages for the same contact never interleave or double-persist.
 */
export function createAgent(deps: AgentDeps): Agent {
  const chains = new Map<string, Promise<unknown>>();
  // handleOne is exception-safe by construction (every fallible step below has its own fallback,
  // plus an outer safety net), so prev's fulfill/reject handlers are identical either way.
  const serialize = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = chains.get(key) ?? Promise.resolve();
    const settle = prev.then(fn, fn);
    chains.set(key, settle);
    // Free this contact's slot once idle (no newer call queued behind this one), so a long-running
    // process serving many distinct contacts over time doesn't leak one Map entry per contact forever.
    // settle can never reject (handleSafely converts every throw into a resolved DeliveryResult), so
    // only the fulfillment arm is reachable — a symmetric reject arm would be permanently dead code.
    void settle.then(() => { if (chains.get(key) === settle) chains.delete(key); });
    return settle;
  };

  return {
    handle: (message) => serialize(message.contactId, () => handleSafely(message, deps)),
  };
}

async function handleSafely(message: InboundMessage, deps: AgentDeps): Promise<DeliveryResult> {
  try {
    return await handleOne(message, deps);
  } catch (e) {
    // Absolute last resort: some dependency (tracer, skill registry, clock, idGenerator, ...) threw
    // somewhere not already given a typed fallback above. Still answer honestly rather than reject.
    return { status: "failed", reason: e instanceof Error ? e.message : String(e) };
  }
}

async function safeLoad(memory: Memory, contactId: string): Promise<Turn[]> {
  try {
    return await memory.load(contactId);
  } catch {
    return []; // degrade to a "new contact" view rather than blocking the whole turn on a memory outage
  }
}

async function safeAppend(memory: Memory, turn: Turn): Promise<void> {
  try {
    await memory.append(turn);
  } catch {
    // best-effort: a persistence hiccup must not cost the user their reply
  }
}

/** M13: `undefined` on any failure (missing store, backend outage, expired) — a session-profile
 * hiccup degrades to "no profile this turn," never blocks the reply, same posture as `safeLoad`. */
async function safeLoadSessionProfile(store: SessionProfileStore | undefined, contactId: string, now: number): Promise<SessionProfile | undefined> {
  if (!store) return undefined;
  try {
    return await store.get(contactId, now);
  } catch {
    return undefined;
  }
}

/** Only ever called from behind an `if (deps.sessionProfileStore)` guard at the call site — takes
 * a required `store`, not `| undefined`, so there's no redundant/untested defensive branch here. */
async function safeSetSessionProfile(store: SessionProfileStore, profile: SessionProfile): Promise<void> {
  try {
    await store.set(profile);
  } catch {
    // best-effort: a persistence hiccup must not cost the user their reply
  }
}

/** Renders a `SessionProfile` into the small text block `assemble.ts`'s `sessionProfile` input
 * expects — kept here (not in assemble.ts, which stays decoupled from the profile's shape) since
 * this is the one caller that actually has a `SessionProfile` to render. `undefined` when there's
 * nothing worth including (no facts, no currentState, no summary) — an all-empty profile renders
 * to nothing rather than an empty placeholder section. */
function renderSessionProfile(profile: SessionProfile | undefined): string | undefined {
  if (!profile) return undefined;
  const lines: string[] = [];
  const factEntries = Object.entries(profile.facts);
  if (factEntries.length > 0) lines.push(`Known facts about this contact: ${factEntries.map(([k, v]) => `${k}: ${v}`).join("; ")}`);
  if (profile.currentState) lines.push(`Current state of this thread: ${profile.currentState}`);
  if (profile.summary) lines.push(`Session summary so far: ${profile.summary}`);
  return lines.length > 0 ? lines.join("\n") : undefined;
}

/** Runs an optional hook (RAG/tools/escalate), swallowing a throw so one integration's outage
 * degrades to "no extra context" rather than losing the whole turn (§10, "each step with a fallback"). */
async function safeCall<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

/**
 * Resolves a contact's pending confirmation in response to a "confirm"/"cancel" button reply (T8.5).
 * `parsed.pendingId` — embedded in the button's own selectionId by `confirmSelectionId()`/
 * `cancelSelectionId()` when the confirmation was first requested — MUST match the CURRENT pending
 * confirmation's own id before anything executes: WhatsApp buttons are static once sent, so if this
 * contact was asked to confirm action A, didn't answer, and was later asked to confirm a different
 * action B (which replaces A as their one pending confirmation), a stale tap on A's old "Confirm"
 * button must not execute B — a confused-deputy replay, not hypothetical, since `request()`
 * unconditionally supersedes an earlier unresolved confirmation for the same contact. A mismatch
 * leaves the CURRENT pending confirmation untouched (it wasn't what the user actually replied to),
 * so a genuine reply to it can still resolve it later.
 *
 * `resolve()` is awaited BEFORE the tool ever runs (not after) so the pending state is gone the
 * instant this function starts acting on it — combined with `createAgent`'s own per-contact
 * serialization (two messages for the same contact are never handled concurrently), a duplicate
 * "confirm" delivered twice back-to-back can never execute the tool twice: the second one finds
 * nothing pending (§9 "confirm executes once even if 'yes' is delivered twice").
 */
async function resolvePendingConfirmation(message: InboundMessage, parsed: ParsedConfirmSelection, confirmFlow: ConfirmFlow, deps: AgentDeps): Promise<SmartMessage> {
  const pending = await safeCall(() => confirmFlow.getPending(message.contactId), undefined);
  if (!pending) return { text: NOTHING_PENDING_TEXT };
  if (pending.id !== parsed.pendingId) return { text: STALE_CONFIRMATION_TEXT };

  await safeCall(async () => {
    await confirmFlow.resolve(message.contactId);
    return undefined;
  }, undefined);

  if (parsed.action === CANCEL_ACTION) {
    trace(deps.tracer, "tools", "invoke", { toolName: pending.toolName, confirmOutcome: "canceled" });
    return { text: `Okay, I've canceled that — ${pending.summary} was not carried out.` };
  }

  trace(deps.tracer, "tools", "invoke", { toolName: pending.toolName, confirmOutcome: "confirmed" });
  const tool = deps.tools?.find((t) => t.name === pending.toolName);
  if (!tool) return { text: CONFIRM_TOOL_UNAVAILABLE_TEXT };

  const toolResult = await safeCall(() => tool.execute(pending.args), { toolName: pending.toolName, ok: false, error: "internal error invoking tool" });
  if (toolResult.ok) return { text: `Done — ${pending.summary} completed.` };

  await safeCall(async () => {
    await deps.onEscalate?.(message, { intent: "confirm", needsRAG: false, needsTool: true, escalate: true, confidence: 1 });
    return undefined;
  }, undefined);
  return { text: `I couldn't complete that (${toolResult.error ?? "unknown error"}) — I've let the team know and they'll follow up.` };
}

/**
 * A textual stand-in for what was persisted to memory: `SmartMessage.text` is independent of
 * `buttons`/`list`/`cta`/`media` (§6.3 "the model controls UX intent — buttons vs list vs text"), so
 * a rich reply with no `text` set would otherwise persist as `Turn.text: undefined` — which
 * model.ts's `toModelMessages()` then filters out entirely, making the agent's own reply invisible
 * to itself on the next turn. Every real caller here (`composeSmartMessage`'s degrade path always
 * sets `text`; every other reply in this file — refusal, oversized-decline, confirm/cancel — also
 * always sets `text`) only ever produces a `SmartMessage` satisfying `SmartMessageSchema`'s own
 * `.refine()`, which requires at least one of text/buttons/list/cta/media — so `parts` is never
 * empty here; no fallback-to-undefined branch is reachable to simplify away.
 */
function summarizeReply(message: SmartMessage): string {
  if (message.text) return message.text;
  const parts: string[] = [];
  if (message.buttons) parts.push(`buttons: ${message.buttons.map((b) => b.title).join(", ")}`);
  if (message.list) parts.push(`list: ${message.list.sections.flatMap((s) => s.rows.map((r) => r.title)).join(", ")}`);
  if (message.cta) parts.push(`link "${message.cta.text}": ${message.cta.url}`);
  if (message.media) parts.push(message.media.caption ? `${message.media.kind}: ${message.media.caption}` : message.media.kind);
  return `[${parts.join("; ")}]`;
}

function trace(tracer: Tracer, system: TracedSystem, event: string, data?: unknown): void {
  try {
    tracer.record(system, event, data);
  } catch {
    // observability must never cost the user their reply
  }
}

async function handleOne(message: InboundMessage, deps: AgentDeps): Promise<DeliveryResult> {
  trace(deps.tracer, "memory", "load", { contactId: message.contactId });
  const history = await safeLoad(deps.memory, message.contactId);
  // M13: read alongside memory.load() — deps.clock.now() drives the TTL check inside get(), so an
  // expired profile comes back as undefined here, not stale state from a prior session.
  const sessionProfile = await safeLoadSessionProfile(deps.sessionProfileStore, message.contactId, deps.clock.now());

  // The idempotency marker is the REPLY turn, not the inbound one: the inbound turn is persisted
  // unconditionally below, long before the message is actually answered, so checking for it would
  // treat "we started this turn" as "we finished it" — an ordinary send failure (not just a crash)
  // would then make a legitimate retry silently report "sent" without ever composing/sending anything.
  const replyTurnId = deps.idGenerator?.(message) ?? `${message.id}:reply`;
  if (history.some((t) => t.id === replyTurnId)) {
    return { status: "sent" }; // already fully answered in a prior attempt — never re-send
  }

  // An oversized message.text is bounded BEFORE anything else uses it: truncated (with a notice) for
  // normal processing, or — beyond refuseChars — skips routing/compose entirely for a fixed, honest
  // decline (§10 "extremely large -> polite refusal, still one reply"). Never store the raw oversized
  // text in Memory either, or a huge blob just moves from "in the prompt" to "in the next prompt."
  const bounded = message.text !== undefined ? boundInboundText(message.text, deps.inboundTextLimits ?? DEFAULT_INBOUND_TEXT_LIMITS) : undefined;
  const effectiveText = bounded ? (bounded.refuse ? OVERSIZED_PLACEHOLDER : bounded.text) : message.text;

  // Guarded the same way as the reply turn below: a retry of a message whose PREVIOUS attempt
  // persisted the user turn but failed before sending must not re-append it. This can't rely on the
  // Memory backend itself being idempotent-by-id (that's an implementation detail of
  // createLibsqlMemory, not part of the Memory interface's contract) — a non-deduping backend would
  // otherwise accumulate duplicate turns in history across every retry before an eventual success.
  if (!history.some((t) => t.id === message.id)) {
    const now = deps.clock.now();
    await safeAppend(deps.memory, { id: message.id, contactId: message.contactId, role: "user", text: effectiveText, timestamp: now });
  }

  // Only computed when a confirmFlow is configured at all — parseConfirmSelection() returning a
  // result additionally requires the selectionId to carry a specific pending confirmation's id
  // (confused-deputy protection; see resolvePendingConfirmation()'s own doc comment).
  const parsedConfirm = deps.confirmFlow ? parseConfirmSelection(message.selectionId) : undefined;

  let reply: SmartMessage;
  // M13: only set on the compose path (refusal/confirm replies don't route through the model, so
  // there's nothing to extract) — merged over the existing profile, not replacing it, when written below.
  let extracted: { facts?: Record<string, string>; currentState?: string; summary?: string } = {};
  if (bounded?.refuse) {
    reply = { text: REFUSAL_TEXT };
  } else if (parsedConfirm) {
    // A confirm/cancel button reply carries no routable intent of its own (a bare "confirm" means
    // nothing to the router without the pending-confirmation context) — resolved here, before
    // routing, instead of through the normal skill/RAG/tool/compose pipeline.
    reply = await resolvePendingConfirmation(message, parsedConfirm, deps.confirmFlow!, deps);
  } else {
    trace(deps.tracer, "router", "route");
    let decision: RouterDecision;
    try {
      // The full tool pool's names, not just a skill's own subset — the router decides needsTool
      // (and which skill) BEFORE a skill is chosen, so it can't yet know a skill-scoped list.
      // Previously hardcoded to [] here, which made the router's own prompt literally say
      // "Available tools: (none)" even when tools existed — found by hand-testing a real
      // conversation: "show me your products" was declined because the router, told there were no
      // tools at all, never set needsTool even though searchProducts was fully wired.
      // The full tool pool's names, not just a skill's own subset — the router decides needsTool
      // (and which skill) BEFORE a skill is chosen, so it can't yet know a skill-scoped list.
      // Previously hardcoded to [] here, which made the router's own prompt literally say
      // "Available tools: (none)" even when tools existed — found by hand-testing a real
      // conversation: "show me your products" was declined because the router, told there were no
      // tools at all, never set needsTool even though searchProducts was fully wired.
      decision = await deps.router.route({ message: { ...message, text: effectiveText }, history, availableSkills: deps.skills?.names() ?? [], availableTools: deps.tools?.map((t) => t.name) ?? [] });
    } catch {
      decision = { intent: "general", needsRAG: false, needsTool: false, escalate: false, confidence: 0 };
    }

    const confident = decision.confidence >= (deps.confidenceThreshold ?? 0.3);
    const budget = deps.contextBudget ?? DEFAULT_CONTEXT_BUDGET;

    const skillFragments: string[] = [];
    let skillToolNames: string[] = [];
    if (confident && decision.skill) {
      const skill = await safeCall(async () => deps.skills?.get(decision.skill!), undefined);
      if (skill) {
        trace(deps.tracer, "skill", "selected", { skill: skill.name });
        skillFragments.push(skill.promptFragment);
        skillToolNames = skill.tools ?? [];
      }
    }

    // Tool-invocation findings are typically more directly actionable (e.g. "order 8842: shipped")
    // than generic RAG recall, so they're kept in their own array and placed AHEAD of recalledSnippets
    // when the two are combined below — capArrayFromEnd drops from the tail first, so this ordering
    // means generic RAG results are dropped before tool findings under budget pressure, not the reverse.
    const toolFindings: string[] = [];
    const recalledSnippets: string[] = [];
    if (confident && decision.needsRAG && deps.retrieveRag) {
      trace(deps.tracer, "rag", "retrieve");
      const snippets = await safeCall(() => deps.retrieveRag!({ contactId: message.contactId, query: effectiveText ?? "" }), []);
      recalledSnippets.push(...snippets);
    }

    const toolSchemas: string[] = [];
    if (confident && decision.needsTool) {
      if (deps.invokeTools) {
        trace(deps.tracer, "tools", "invoke");
        // Uses the same bounded/truncated text every other consumer (router, RAG query, selectTools,
        // the persisted turn) already uses — not the raw, unbounded message.
        const findings = await safeCall(() => deps.invokeTools!({ message: { ...message, text: effectiveText }, decision }), []);
        toolFindings.push(...findings.map((f) => `Tool result: ${f}`));
      }
      if (deps.tools && deps.tools.length > 0) {
        const selected = selectTools({ tools: deps.tools, message: effectiveText ?? "", alwaysInclude: skillToolNames, maxTokens: Math.floor(budget.promptBudget * TOOL_SCHEMAS_BUDGET_FRACTION) });
        toolSchemas.push(...selected.map((t) => JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters })));
      }
    }

    if (decision.escalate && deps.onEscalate) {
      await safeCall(async () => {
        await deps.onEscalate!(message, decision);
        return undefined;
      }, undefined);
    }

    // §10 "out-of-scope ask -> honest decline": a standing instruction, not special-cased branching —
    // the model is trusted to say so plainly rather than guess when a request is genuinely unrelated
    // to what it's configured to help with. Kept as its own leading skill-like fragment.
    const windowed = await windowHistory({ model: deps.model, memory: deps.memory, contactId: message.contactId, history, maxRecentTurns: deps.maxRecentTurns ?? DEFAULT_MAX_RECENT_TURNS, clock: deps.clock, tracer: deps.tracer });

    const composed = await composeWithBudget({
      model: deps.model,
      input: {
        system: `${SCOPE_GUARDRAIL}\n\n${FORMAT_REASONING}\n\n${GROUNDING_HONESTY}`,
        sessionProfile: renderSessionProfile(sessionProfile),
        skillFragments,
        toolSchemas,
        summary: windowed.summary,
        recalledSnippets: [...toolFindings, ...recalledSnippets],
        recentTurns: windowed.recentTurns,
        userMessage: effectiveText ?? "(no text)",
      },
      budget,
    });
    // One "llm" event (not two) carries both the compose step and its token-usage-per-section (T6.9)
    // — spine A's own assertion counts "llm" trace events as a proxy for underlying model calls, and
    // this compose step is exactly one such call (retries/shrinks happen inside composeWithBudget).
    trace(deps.tracer, "llm", "compose", { usage: composed.usage, dropped: composed.dropped, shrunkForContextLength: composed.shrunkForContextLength, formatRationale: composed.formatRationale });
    reply = composed.reply;
    // M13: this same compose call drafted the extraction, for free — carried through to the write
    // below rather than a second read of `composed` (which is out of scope past this block).
    extracted = { facts: composed.sessionFacts, currentState: composed.sessionCurrentState, summary: composed.sessionSummary };
  }

  const channelSystem = KNOWN_TRACED_CHANNELS.has(deps.channel.name) ? (deps.channel.name as TracedSystem) : undefined;
  if (channelSystem) trace(deps.tracer, channelSystem, "send");
  let result: DeliveryResult;
  try {
    result = await deps.channel.send(message.contactId, reply);
  } catch (e) {
    result = { status: "failed", reason: e instanceof Error ? e.message : String(e) };
  }

  // Only record the agent as having replied when something actually reached the user — a "failed"/
  // "queued" result must not leave a turn in history claiming the agent said something it didn't,
  // which would otherwise get fed back to the model as prior context on the contact's next message.
  //
  // Uses summarizeReply(), not reply.text directly, since a buttons/list/cta/media-only SmartMessage
  // has no `text` at all (§6.3 — the model is free to choose this from the start, not gated behind a
  // future milestone). On "fellBack" the channel actually delivered renderNumberedFallback()'s plain
  // text, not this summary — an acceptable approximation (same offer, reworded) rather than plumbing
  // the literal delivered text back through DeliveryResult, but worth revisiting if that mismatch
  // ever matters (e.g. the numbered options' exact wording becomes something the model must recall).
  if (result.status === "sent" || result.status === "fellBack") {
    await safeAppend(deps.memory, { id: replyTurnId, contactId: message.contactId, role: "agent", text: summarizeReply(reply), timestamp: deps.clock.now() });

    // M13: written at the same point the reply gets persisted — facts MERGE (a fact once learned
    // isn't lost just because this turn didn't re-state it), currentState/summary REPLACE wholesale
    // when this turn produced a new one (else carried over as-is — "allowed to lag", not forced to
    // null every turn). expiresAt is always stamped fresh here, which is also how the TTL renews.
    if (deps.sessionProfileStore) {
      const now = deps.clock.now();
      const nextCurrentState = extracted.currentState ?? sessionProfile?.currentState;
      const nextSummary = extracted.summary ?? sessionProfile?.summary;
      await safeSetSessionProfile(deps.sessionProfileStore, {
        contactId: message.contactId,
        facts: { ...(sessionProfile?.facts ?? {}), ...(extracted.facts ?? {}) },
        ...(nextCurrentState !== undefined ? { currentState: nextCurrentState } : {}),
        ...(nextSummary !== undefined ? { summary: nextSummary } : {}),
        expiresAt: now + (deps.sessionProfileTtlMs ?? DEFAULT_SESSION_PROFILE_TTL_MS),
      });
    }
  }

  return result;
}
