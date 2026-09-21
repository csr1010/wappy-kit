# @wappy/core — contract signatures (M1 T1.1)

Prose reference for the frozen public API of `@wappy/core`. The source of truth is
`packages/core/src/*.ts`; `contracts/core.api.json` (B3) snapshots it and fails the
gate on a breaking change. Later sessions should only need this file, not core source.

## Data schemas (zod, `schemas.ts`)

- `InboundMessageSchema` -> `InboundMessage`: `{ id, contactId, channel, text?, media?, selectionId?, timestamp, raw? }`. `selectionId` (added M3) is the stable id of a picked button/list-row/quick-reply — routing must key off this, never off `text` (titles can be duplicated/localized/renamed). `InboundMedia` (added M3) also carries `latitude?`/`longitude?`, meaningful only when `kind === "location"`.
- `SmartMessageSchema` -> `SmartMessage`: `{ text?, buttons?, list?, cta?, media?, quoteId?, flow? }`, at least one of text/buttons/list/cta/media required.
  - **Layering rule (§6.1):** this schema enforces *structural* limits only — max 3 buttons, max 10 list rows total. It does **not** enforce string-length limits (button title <=20, list row title <=24, description <=72); those are truncated by `@wappy/whatsapp` at send time (M4). An over-length string is valid input here.
  - `flow` is a reserved, unvalidated slot for WhatsApp Flows/forms (deferred; SPEC §6.1).
  - `smartMessageJsonSchema` — JSON Schema form (via `z.toJSONSchema`), passed to the model as `responseSchema` when it must emit a SmartMessage (§6.3).
- `DeliveryResultSchema` -> `DeliveryResult`: `{ status: sent|failed|queued|fellBack, messageId?, reason? }`. `reason` is required when `status` is `failed` or `fellBack` (actionable, never a stack trace — §10).
- `TurnSchema` -> `Turn`: `{ id, contactId, role: user|agent|system, text?, timestamp, meta? }`.
- `RouterDecisionSchema` -> `RouterDecision`: `{ intent, skill?, needsRAG, needsTool, escalate, confidence }`, `confidence` clamped to `[0,1]`.
- `ToolResultSchema` -> `ToolResult`: `{ toolName, ok, data?, error? }`.

## Interfaces (`interfaces.ts`)

- `Agent.handle(message: InboundMessage): Promise<DeliveryResult>` — orchestrates one inbound message -> reply.
- `Router.route(input: RouterInput): Promise<RouterDecision>`, `RouterInput = { message, history, availableSkills, availableTools }`.
- `Tool = { name, description, parameters: JsonSchema, readOnly, confirmBefore, execute(args) -> Promise<ToolResult> }`. `readOnly`/`confirmBefore` live on the tool itself (not the provider) so a provider can mix safe and gated tools; provider/install-time `allowList` filtering is a curation concern (M7), typed as `ToolProviderConfig` there — not part of the M1 interface.
- `ToolProvider = { name, listTools(): Tool[] | Promise<Tool[]> }` — generates tools from a source (OpenAPI, Shopify, custom).
- `MessageChannel = { name, receive(rawWebhook): InboundMessage[] | Promise<InboundMessage[]>, send(to, message): Promise<DeliveryResult> }`.
  - Deviation from SPEC §3 prose (`receive(rawWebhook) -> InboundMessage`): returns an **array**. One webhook payload can batch several message events, or contain zero when it's a status/read-receipt-only notification (§6.2) — a single required `InboundMessage` can't express "no message this call" without a sentinel. `send` takes an explicit `to` because one channel instance serves many contacts.
- `Memory = { load(contactId): Promise<Turn[]>, append(turn): Promise<void>, recall(contactId, query): Promise<string[]> }`.
  - Deviation from SPEC §3 prose (`recall(query) -> snippets`): `recall` also takes `contactId` — recall must be scoped to a contact's own history/knowledge, not global.
- `Skill = { name, description, promptFragment, tools?: string[], memorySchema? }` — **new core interface, ratified here** (SPEC §16). Matches the glossary definition (§17): prompt fragment + tools + optional memory schema for one capability. `tools` names reference tools exposed by registered `ToolProvider`s; `memorySchema` is opaque to core.
- `Model.generate(req: ModelRequest): Promise<ModelResult>`, `ModelRequest = { prompt, history?, tools?, responseSchema? }`, `ModelResult = { text?, structured?, toolCalls? }` — the Vercel AI SDK (or any provider) sits behind this port (§2.1).
- `Clock = { now(), setTimeout(fn, ms), clearTimeout(handle), sleep(ms) }` — every timing concern (retry/backoff, session-window checks) goes through this; never call `Date.now`/`setTimeout` directly. `systemClock` is the real impl; tests inject `testkit`'s `fakeClock`.
- `Logger = { debug, info, warn, error }` — `noopLogger` is the default no-op.

## Plugin registry (`registry.ts`)

- `PluginRegistry` — constructed with the running core version; `register(plugin)` throws on a duplicate `name` or when `plugin.coreVersionRange` doesn't `satisfiesRange` the running core version; `get<T>(kind, name?)` returns the first match or `undefined` (never throws on an unknown/unregistered kind); `list(kind?)` preserves registration order.
- `PluginKind = "channel" | "memory" | "router" | "toolProvider" | "skill" | "model"`.
- `satisfiesRange(version, range)` (`semver.ts`) — minimal range grammar (`*`, exact, `~`, `^`); core stays dependency-light (zod + nothing else).
- `resolveEnabledPlugins(registry, { enabled: string[] })` — pure config loader: maps the enabled-name list (in that order) to registered plugins, throws on an unknown name. File/ledger persistence of the enabled list is M2's concern; this just resolves an already-loaded config object.

## Setup manifest (`setup-manifest.ts`)

- `SetupManifest = { part, steps: SetupStep[] }`, `SetupStep = { id, description, envKeys? }` — each part declares its own.
- `aggregateSetupManifests(manifests)` -> `{ steps: (SetupStep & { part })[], envKeys: string[] }` — flattens + dedupes env keys; throws on a duplicate step `id` *within the same part* (the same id in two different parts is fine — they're namespaced by `part`). Ledger persistence (writing `.wappy/state.json`) is M2.

## Tracer (`tracer.ts`)

- `TracedSystem = "whatsapp" | "memory" | "router" | "skill" | "rag" | "tools" | "llm"` (§9 canonical trace systems).
- `Tracer = { record(system, event, data?), touched(): Set<TracedSystem>, events(): TraceEvent[] }`. `touched()`/`events()` return snapshot copies (not live references) so callers can't mutate tracer state.
- `createInMemoryTracer(clock?)` — the M1 in-memory impl; spine tests (M5+, B5) assert `touched()` equals the exact expected system set per scenario (§9 A/B/C).

## Ratified additions to core (resolves SPEC §15 open question 1)

- **Tracer** — added to core (was missing from §3's list; needed for §9 traces and the M5 spine tests).
- **Skill** — added to core (§13/§17 already treat it as a core interface; §3 had omitted it).
- **Knowledge/RAG** — does **not** get a core interface. It lives in `@wappy/harness` (M8), consumed through `Memory.recall` + a skill's `promptFragment`; core stays domain/RAG-agnostic.

See SPEC.md §16 Decisions Log for the dated entry.
