# Wappy Kit — Open-Source WhatsApp Agent OS — Master Spec (Living Document)

**STATUS:** Design-locked, pre-implementation. Green-lit for v0.1 build. This is the single source of truth for the project. On any session resume, READ `docs/PROGRESS.md` first, then use `pnpm ctx M<n>` to load only the spec sections you need. When plans change, UPDATE THIS FILE in place (bump the version + add to the Decisions Log).

**Spec version:** 2.1
**Last updated:** 2026-09-21
**Project:** Wappy Kit — an open-source WhatsApp Agent OS.
**Repo:** This repository IS the entire project. It is a standalone open-source library published to npm.
**Hard constraint:** 100% open-source, vendor-neutral (no proprietary/single-vendor lock-in), no forced cloud, local-first, users own their data.

Read this framing first. Wappy Kit is a foundation, nothing more. It is the open-source WhatsApp Agent OS: three parts + a core + a CLI. It deliberately does NOT contain any business or domain logic. Functional/business applications (e.g. a travel-booking agent, a CRM) can later be built on top of Wappy Kit — but those are separate projects, out of scope for this repo (see §13). This spec describes only the OS.

## 0. What this is and why it exists

WhatsApp is where billions of people already talk to businesses, yet the tooling treats it as a one-way notification pipe. The "conversational" options (Twilio, Gupshup, Landbot, and friends) are rigid visual flow-builders, not real agents — and critically, none of them can call your existing APIs as tools. If you already have an API (an order system, a booking engine, a store), there is no open, code-first way to put a real, memory-aware agent in front of it on WhatsApp.

That empty space is the project:

> A WhatsApp Agent OS — bring your own number, model, and data. Turn your existing API into a real, memory-aware WhatsApp agent, on a local-first foundation you fully control.

We are building this open-source first. There is no companion product, no hosted platform assumed by this spec. Wappy Kit stands entirely on its own: a developer runs one command, answers a short interview, and gets a runnable WhatsApp agent wired to their model, their memory, their WhatsApp number, and their API.

Viral launch hook: "Turn your Shopify store into a WhatsApp shopping agent — one command." (Shopify is the flagship demo; the engine underneath is generic OpenAPI, so it works for anyone with a spec.)

### 0.1 Design realizations that shaped it

- Don't reinvent the agent framework. Stand on the proven, provider-agnostic tool-calling loop (Vercel AI SDK) and, optionally, durable memory/orchestration (Mastra). We own only what is genuinely missing.
- What's missing is three things — and they are equal pillars, not one headline feature:
  1. a WhatsApp-native messaging layer (rich message types + a reliability engine),
  2. an agent harness (the runtime: model loop + memory + router),
  3. an API→Tools engine (turn an OpenAPI spec into callable tools).
- The router is the identity. The product is a router that can also converse: a cheap decision layer that picks the smallest correct path per message, so "hi" never touches your API or a vector store.

## 1. Product principles

1. Foundation, not functional logic. We remove the undifferentiated 80% (plumbing). Whoever builds on Wappy Kit supplies the 20% that is their own (domain skills, tools, prompt, knowledge). We never ship their business logic.
2. Wrap, don't reinvent. Stand on proven OSS. We own only WhatsApp + API→tools + router + CLI.
3. Local-first / own-your-data. Default everything to local files. Cloud is opt-in, never required.
4. Bring your own everything. Own WhatsApp number (Meta creds), own model key, own hosting, own data.
5. Provider-agnostic. Model, memory, and router are all pluggable behind interfaces; no single vendor is load-bearing.
6. Augment, never replace, the LLM. Memory feeds context; the Router makes cheap typed decisions; the LLM writes replies and fills tool args.
7. Graceful degradation everywhere. Rich→text fallback, tool-failure fallback, honest out-of-scope replies. A customer always gets something useful.
8. Idempotent + resumable. Every install step and every webhook is safe to repeat.

## 2. Architecture — core + 3 parts (hub-and-spoke)

Monorepo (pnpm + Turborepo). The three parts are plugins that depend ONLY on core; plugins NEVER import each other; core imports NOTHING from plugins; the CLI orchestrates. This prevents circular deps and keeps every part swappable.

```
@wappy/core          Contracts + runtime wiring + plugin registry + install-state ledger
@wappy/harness       PART 1 — the agent runtime: Agent/Router/Memory (Vercel AI SDK loop; memory adapters)
@wappy/whatsapp      PART 2 — the WhatsApp channel: rich message types + reliability engine
@wappy/tools-openapi PART 3 — the API→Tools engine: OpenAPI/Swagger + Shopify connector
create-wappy         CLI scaffolder: interview -> install core + chosen parts -> generate a runnable project
```

Interop rule: the parts "all understand each other" because they all implement/consume the SAME core interfaces and share the SAME state ledger. Contract stability (strict semver on @wappy/core) is the #1 discipline.

### 2.1 Tech stack decisions (locked for v0.1)

- Language: TypeScript, Node.js. Distributed via npm.
- Agentic core: Vercel AI SDK (`ai`) — model + tool-calling loop, provider-agnostic (OpenAI / Anthropic / Gemini / local Ollama).
- Orchestration/memory (optional): Mastra for durable workflows + memory. Default memory = LibSQL/SQLite local file. Advanced (opt-in, self-hostable, still local): Mem0 or Cognee.
- Router/decision layer: LLM-based default (works fully local/offline with the user's chosen model); Jev by TypeSafe AI as an optional System-One backend (see §7).
- Interactive prompts in CLI: @clack/prompts (or equivalent).
- OpenAPI parsing: a mature parser lib (e.g. an openapi/swagger parser) — do NOT hand-roll.

## 3. Core contracts (@wappy/core) — freeze early

These interfaces are the whole ballgame. Draft precisely before building the three parts.

- **Agent** — orchestrates a single inbound message → reply. Holds references to Router, Memory, Tools, Channel, Model.
- **Router** (decision layer) — input: `{ message, history, availableSkills, availableTools }`; output (typed): `{ intent, skill?, needsRAG: boolean, needsTool: boolean, escalate: boolean, confidence: number }`. Two impls: LLM-based, Jev-based.
- **Tool / ToolProvider** — a callable tool `{ name, description, parameters(JSONSchema), execute(args) }`. Providers generate tools (OpenAPI, Shopify, custom). Supports allowList, confirmBefore, readOnly.
- **MessageChannel** — `receive(rawWebhook) -> InboundMessage`, `send(SmartMessage) -> DeliveryResult`. WhatsApp is the first channel; the interface leaves room for others later.
- **Memory** — `load(contactId) -> history`, `append(turn)`, `recall(query) -> snippets`, pluggable backends.
- **SmartMessage** (rich response schema) — `{ text, buttons?, list?, cta?, media?, quoteId? }` (see §6).
- **PluginRegistry** — parts self-register a `register(registry)`; core loads the enabled list from config.
- **SetupManifest** — each part declares its setup steps + required env keys; core aggregates into the state ledger (see §5).
- **Tracer** — `record(system, event)` / `touched()` / `events()`; systems = `whatsapp|memory|router|skill|rag|tools|llm`; powers the §9 canonical-trace assertions (ratified M1, see Decisions Log).
- **Skill** — prompt fragment + tools + optional memory schema for one capability (§17 glossary); ratified as a core interface M1 (see Decisions Log).

## 4. CLI: create-wappy — interview + commands

### 4.1 Install interview (order matters)

1. Model? OpenAI / Anthropic / Gemini / local Ollama → writes provider config + .env placeholder key.
2. Existing agent framework? None (we set up Vercel AI SDK/Mastra) / I use Mastra / Vercel AI SDK / LangGraph → if none, scaffold default; if they have one, generate an adapter stub (wrap, don't dictate).
3. Skills? none / pick reference skills (v0.1 ships a couple; NO downloading external skills yet).
4. Tools / existing APIs? "Do you have OpenAPI/Swagger or Shopify?" → paste spec URL/file or choose Shopify connector → generate tools. (No code-introspection in v0.1.)
5. Memory? local file (default) / Mem0 / Cognee / Postgres → wire adapter + env keys.
6. Router? LLM (default) / Jev → optional System-One backend.
7. WhatsApp? enter Cloud API creds now / later → .env placeholders + webhook route.

Output: a runnable project — `index.ts` (wires model+memory+router+tools+skills+WhatsApp), `tools/*.ts`, `skills/*.ts`, `.env.example`, `.wappy/state.json`, and a README that walks them through getting Meta creds + filling each env key.

### 4.2 CLI commands

- `create-wappy` — run/resume the interview (reads state, continues from first incomplete step).
- `wappy status` — show installed parts, done/pending/blocked steps, filled vs. missing env.
- `wappy reset [--plugin <name>]` — clean & redo a scope (clears state + generated files for that scope).
- `wappy doctor` — validate env + connectivity (model key, WhatsApp creds, API reachability), detect manual drift.
- `wappy dev` — boot server + tunnel, print public /webhook URL for Meta config.

## 5. The install-state ledger ("light memory") — @wappy/core owns it

Not intelligence — a local JSON state file that makes installs trustworthy, resumable, and cleanable.

- Path: `.wappy/state.json` at project root (git-ignored).
- Records: schemaVersion, installed parts + versions, per-part setup steps `{id, status: pending|done|failed, error?}`, env keys requiredVsFilled, lastStep, timestamps, runId.
- Each part contributes its own SetupManifest; core aggregates → unified ledger (each node has its own spec, core holds the progress).
- Powers: resume, status, reset/redo, doctor.
- Safety: every generator step is idempotent (check state before acting); a lock file prevents concurrent runs; corrupted/partial state → validate + offer reset; schemaVersion enables migrations across core versions.
- State edge cases: corrupted file (validate+reset), concurrent runs (lock), version migration (schema version), user hand-edited generated files (doctor detects drift and warns).

## 6. PART 2 — WhatsApp-native messaging layer (@wappy/whatsapp)

### 6.1 Message types to support (the "smart send" layer)

The agent returns a SmartMessage intent; the framework picks the best type, validates constraints, checks eligibility, sends, tracks receipt, and falls back.

- Text + formatting (bold/italic/strikethrough/mono; URL preview).
- Reply buttons (max 3, title ≤20 chars → auto-truncate or fall back to numbered text).
- List messages (≤10 rows/sections; row title ≤24, desc ≤72).
- CTA URL button (link as a real button, not raw inline URL).
- Media: image / document / video / audio / voice note; captions; inbound media download too.
- Location (send + request).
- Reactions (emoji ack). Quoted replies (reply-in-context).
- Typing indicator + mark-as-read (presence).
- Templates (for proactive / outside 24h window; variable + button mapping).
- Flows / forms — DEFERRED (needs a published Flow + eligibility). Leave a slot in SmartMessage so it slots in later.

### 6.2 Reliability engine (what everyone else skips)

- Capability-aware send + fallback: try richer type → on Meta rejection/error code or non-delivery → auto re-render as plain text with numbered options.
- Delivery/read-receipt tracking → retry: handle sent/delivered/read/failed status webhooks; retry with backoff, then fall back.
- 24h session-window guard: window closed → block free-form; auto-switch to approved template or queue; never silently fail.
- Idempotency: dedupe on message.id (Meta retries deliveries).
- Non-message payloads: webhook must handle status/None payloads without crashing.
- Rate limits + exponential backoff on 429/5xx.
- Error-code mapping: Meta numeric codes → actionable behavior, not stack traces.
- Signature verification: validate X-Hub-Signature-256 (HMAC with app secret); reject forged.

### 6.3 How the model drives it

LLM emits the SmartMessage schema directly (it controls UX intent — buttons vs list vs text); framework enforces WhatsApp constraints + does fallback. (Decision: model-emits-schema over plain-text-hints; see Decisions Log.)

## 7. PART 1 — the harness: router / decision layer (System One vs System Two) (@wappy/harness)

The harness is the agent runtime — model loop + memory + router. Its defining piece is the router.

- System Two (LLM): writes replies, fills tool arguments, RAG synthesis.
- System One (Router): fast typed decisions — in-scope? which skill? escalate (complaint)? confident enough to auto-act vs. confirm?
- Default impl = LLM-based (no extra dependency, fully local-capable).
- Optional impl = Jev by TypeSafe AI: a System-One decision model returning calibrated probabilities for typed questions (Choice/Score/Yes-No). Does NOT generate text or fill tool args → strictly a complement.
- CAVEAT: hosted Jev needs a TypeSafe API key (not local-by-default). The pattern can be made local via a "typed-question over your own model" approach. Verify exact Jev package names/versions/APIs against official docs before depending — web research was indicative, not authoritative.
- The Router is the load-bearing seam: it picks the CHEAPEST correct path per message, so "hi" never touches RAG or your API.

## 8. PART 3 — API-to-Tools engine (@wappy/tools-openapi) — the killer feature

- Inputs for v0.1: OpenAPI/Swagger (URL or file) and Shopify (curated connector). NO code-introspection, NO arbitrary-website discovery in v0.1.
- Mechanics: parse spec → generate one typed tool per operation (operationId=name, summary=description, request schema=params); map auth from security schemes.
- Auth v0.1: API key / bearer / basic (covers Shopify + most SaaS). OAuth → later.
- Spec-bloat control (critical): big specs (Shopify has hundreds of endpoints) overload the model. Mitigations: curate/allow-list at install (by tag or an LLM picks useful ops); read-only by default; tool retrieval at runtime (load only tools relevant to the message).
- Destructive endpoints: write/delete tools gated by confirmBefore + explicit allow-list.
- Schema edge cases ($ref, oneOf, deep nesting): use a mature parser; skip/flag operations that can't be safely mapped rather than emit broken tools.
- Shopify connector = hand-picked tools (products, orders, inventory, customers) = the viral demo. Underlying engine stays generic OpenAPI.

## 9. Runtime message lifecycle (canonical trace)

Every message: verify → parse → load memory → route → (skill/RAG/tool as routed) → LLM compose → gate → send (smart) → persist → trace. Each step has a fallback.

**Scenario A — "hi"**
WhatsApp stack (verify/dedupe/parse/window) → Memory (load, new contact) → Router (greeting, in-scope, no skill/RAG/tool) → LLM (single call, no tools) → WhatsApp send (ideally quick-reply buttons) → persist + trace. Touched: WhatsApp · Memory · Router · LLM. Not touched: RAG, tools. (Cheapest path.)

**Scenario B — "what are your store hours?"**
… Router (intent=hours, route→store-info skill, needsRAG=yes) → Skill injects prompt fragment → RAG (embed → local vector search → retrieve hours chunk) → LLM (grounded answer, no tool) → Router confidence gate → send → persist + trace. Touched: WhatsApp · Memory · Router · Skill · RAG · LLM. Not touched: tools. (Knowledge path.)

**Scenario C — "where's my order 8842?"**
… Router (route→orders skill, needsTool=yes) → Tool call getOrder({id}) (real HTTP via OpenAPI-generated tool) → result → LLM compose → send → persist + trace. Touched: WhatsApp · Memory · Router · Skill · Tools/OpenAPI · LLM. (Tool path.)

Design proof: Router picks cheapest correct path; Memory + WhatsApp hit every message; RAG/tools/skills only when routed; every path ends in persist+send+trace with a fallback.

## 10. Failure points & mitigations (master list)

**WhatsApp/messaging:**
- Webhook retries → idempotent dedupe on message.id.
- 24h window closed → template/queue, never silent fail.
- Rich message unsupported/rejected → fallback to text.
- Delivery failed → retry w/ backoff → fallback.
- Non-message webhooks → handle gracefully.
- Forged webhook → HMAC verify + reject.
- Media too large / bad mime → validate; clear error.

**Agent/harness:**
- Model API error/timeout/rate limit → retry/backoff → honest "try again shortly".
- Tool call fails (their API down) → catch, tell user team will follow up, optionally escalate.
- Out-of-scope ask → honest "I can't help with that".
- Prompt/token overflow (too many tools) → tool retrieval + curation.

**API→tools:**
- Unparseable/huge spec → skip bad ops + curate; fail loud at install, not runtime.
- Destructive op auto-called → confirmBefore + allow-list + read-only default.
- Auth misconfig → doctor validates connectivity at install.

**Install/state:**
- Corrupted state → validate + offer reset.
- Concurrent runs → lock file.
- Core/part version skew → peerDep range + runtime version check + CLI warn.
- Partial/nonsensical install → CLI blocks invalid combos; core degrades gracefully.
- User hand-edited files → doctor detects drift.

**Privacy/security:**
- Secrets only in env, never generated into committed files; .env + .wappy/ git-ignored.
- No data leaves the user's infra unless they opt into a cloud backend/model.

## 11. Security & privacy

- Local-first: memory + state on local disk by default.
- Secrets via env only; scaffold writes .env.example, never real keys.
- WhatsApp webhook signature verification mandatory.
- Bring-your-own model key + WhatsApp creds; no telemetry by default (if any added later, opt-in).

## 12. Usability testing plan (scenario- / TDD-driven)

Acceptance = a real developer can go from `npm create` to a working reply with minimal friction. Test matrix:

- Install DX: each interview path (model×memory×router×tools combos) produces a runnable project; resume after Ctrl-C continues correctly; reset cleans; doctor catches a missing/invalid key.
- API→tools: valid OpenAPI URL → tools generated; Shopify connector → curated tools; broken spec → clear failure at install; huge spec → curation keeps tool count sane; write op → confirmBefore triggers.
- Runtime scenarios (unit + integration): the three canonical traces (hi / hours / order) hit exactly the expected systems; out-of-scope → honest decline; tool failure → graceful fallback.
- WhatsApp reliability: simulate delivery-failed → retry+fallback; window-closed → template path; rich message rejected → text fallback; duplicate webhook → single reply.
- State ledger: corrupted state → reset offered; concurrent run → lock respected; version skew → warned.
- Parser robustness: golden-file tests for $ref/oneOf/nested schemas; snapshot generated tool definitions.

Testing strategy (CLI/library — no browser preview):

- Typecheck + build gate: `tsc --noEmit` + `pnpm build` across the workspace catch contract breaks first.
- Unit tests (vitest): parsers, router decisions, state-ledger transitions, WhatsApp reliability engine — deterministic, no network/TTY. Interview logic lives in plain functions (testable) with a thin @clack/prompts layer on top.
- CLI E2E in-container: run the built binary non-interactively (flags/piped stdin), assert generated files + .wappy/state.json; test resume/reset/doctor by inspecting state and re-running.
- Runtime with mocks: a mock WhatsApp Cloud API + mock model make the three canonical traces deterministic; assert each touched exactly the expected systems.
- Independent E2E: a script/bash-driven test pass validates the CLI + matrix without a browser.
- Live boundary: a real Meta WABA / real tunnel can't be fully automated — everything up to that is mocked; one real message on a real number is a human verification step.

## 13. Applications built ON TOP (out of scope for this repo — future, separate)

This is a boundary, not a feature. Wappy Kit is the foundation only. It ships no domain/business logic and holds no domain state.

- In the future, functional/business applications may be built on top of Wappy Kit — for example a travel-booking agent, or a small CRM for some vertical. Those are ordinary applications that consume Wappy Kit's interfaces; they are NOT part of this open-source repo and do NOT live here.
- Such an app supplies what the OS deliberately omits: its own domain skills, its own tools/connectors, its own data model + persistence (the app decides — local SQLite, Postgres, Mongo, whatever), and its own admin/UI.
- The clean seam that makes this possible: an app implements/consumes the SAME core interfaces (Skill, ToolProvider, Memory, MessageChannel) plus its own domain layer. No fork, no special hooks — it just composes on top. The OS stays pure and swappable.
- Nothing in this spec should be designed around a specific application. If a future app needs something, it either lives in that app, or it becomes a general, domain-agnostic capability of the OS — never a domain-specific one baked into core.

## 14. Roadmap / phases

- **v0.1 (now):** monorepo skeleton + @wappy/core (contracts + state ledger) → create-wappy interview → @wappy/whatsapp + @wappy/harness (message→reply loop alive) → @wappy/tools-openapi (OpenAPI + Shopify). Messaging subset: text/buttons/list/CTA + reliability/fallback. Auth: key/bearer/basic. Router: LLM default (+ Jev optional). Memory: local default (+ Mem0/Cognee optional).
- **v0.2:** website spec discovery (/openapi.json), more connectors, OAuth, richer messaging (media/location/templates polish), skill registry (install community @wappy-skill/*).
- **v0.3+:** code-introspection → OpenAPI (FastAPI/NestJS/Express), Flows/forms, more channels (the MessageChannel interface already anticipates this), evaluation harness, observability dashboard.
- **Non-goals (explicit):** we do NOT build any business/domain logic (that's for apps built on top, §13); no staff scheduling/round-robin/assignment; no forced cloud; no vendor lock-in to a single model.

## 15. Open questions / to confirm at build start

1. Exact @wappy/core interface signatures (draft as the FIRST artifact, before the three parts).
2. Confirm scaffold folder and that the project is pushed to a fresh public GitHub repo. (Status: scaffolded at ~/wappy-kit; pushed to a PRIVATE repo csr1010/wappy-kit — flip to public before v0.1 release, see M11.)
3. Verify Jev's real package/API surface against official docs before wiring it.
4. Reference skills to ship in v0.1 (candidates: store-info (RAG), orders (tools)).

## 16. Decisions log

- 2026-09-21 (v2.1, M1 T1.1): Ratified §15 open question 1 (core interface signatures — see `docs/CONTRACTS.md`). Added **Tracer** and **Skill** to the §3 core contract list (both were already implied by §9/§13/§17 but missing from §3). Confirmed **Knowledge/RAG** gets no core interface — it lives in `@wappy/harness` (M8), consumed via `Memory.recall` + a skill's `promptFragment`. Precision deviations from §3 prose, not semantic changes: `MessageChannel.receive` returns `InboundMessage[]` (a webhook can batch messages or carry zero for a status-only payload); `Memory.recall` takes `(contactId, query)` (recall must be contact-scoped).
- 2026-06-23 (v2.0): Spec rewritten as a standalone, open-source-first project. Removed all assumptions of a companion/hosted product; Wappy Kit stands on its own. Made explicit that functional/business apps built on top are separate, out-of-scope projects (§13). Reframed the architecture as "core + 3 parts (harness, whatsapp, tools-openapi) + CLI".
- 2026-06-23: Architecture = core + 3 independent parts + create-wappy CLI; hub-and-spoke (parts depend only on core).
- 2026-06-23: Agentic core = Vercel AI SDK (+ Mastra optional). Not LangChain. Not a single-vendor SDK.
- 2026-06-23: Memory default = local LibSQL file; Mem0/Cognee optional; env-selectable.
- 2026-06-23: Router = LLM default; Jev optional System-One backend. Jev/memory augment, never replace, the LLM.
- 2026-06-23: API→tools v0.1 = OpenAPI/Swagger (URL/file) + Shopify connector only. No code-introspection/website-discovery yet.
- 2026-06-23: Rich message = model emits SmartMessage schema; framework validates + falls back.
- 2026-06-23: Install-state ledger .wappy/state.json owned by core; idempotent steps; resume/status/reset/doctor.
- 2026-06-23: Feasibility = HIGH, no hard blockers. Green-lit for v0.1.

## 17. Glossary

- **WhatsApp Agent OS** = this project: the open-source foundation (core + 3 parts + CLI) for building WhatsApp agents.
- **The three parts** = Harness (agent runtime), WhatsApp (messaging channel), Tools-OpenAPI (API→tools engine).
- **Harness** = the agent runtime (model + loop + memory + router).
- **Router / decision layer** = System-One typed decisions (route/gate/score).
- **Skill** = prompt fragment + tools + optional memory schema for one capability.
- **Connector** = a curated ToolProvider (e.g. Shopify) vs. raw OpenAPI ingestion.
- **SmartMessage** = the rich-response schema the model emits; framework renders + falls back.
- **State ledger** = .wappy/state.json, the local install "light memory".
- **App on top** = a separate, out-of-scope project (a functional/business app) that consumes Wappy Kit's interfaces (§13).
