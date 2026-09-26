# Architecture

This is the map for anyone extending Wappy Kit, human or AI. It's meant to answer three questions
fast: what does each package do, why is it built that way, and where should I actually go read the
code. If you're a coding agent working in this repo, start here before touching anything.

## Tech stack

- **Language:** TypeScript, Node.js 20+. Distributed via npm.
- **Package manager / monorepo:** pnpm workspaces + Turborepo. `pnpm -w -r build/test` runs every
  package; `pnpm gate <n>` runs the cumulative test/lint/typecheck/coverage gate (see
  `scripts/gate.mjs`).
- **Model layer:** the Vercel AI SDK (`ai`), provider-agnostic (OpenAI, Anthropic, Gemini, or fully
  local Ollama). Nothing in this repo is hardcoded to one provider.
- **Storage:** LibSQL (a SQLite-compatible engine with `@libsql/client`), one local file by default.
  Memory, the session profile, and RAG all share this one engine on purpose, not three different
  storage systems.
- **Local embeddings (RAG):** `@huggingface/transformers`, running a small sentence-embedding model
  fully offline after its one-time download. LibSQL's own native vector column type
  (`F32_BLOB`/`vector_distance_cos`) does the actual similarity search, not a separate vector
  database or SQLite extension.
- **Testing:** Vitest everywhere. Test files are tagged `*.m<N>.test.ts` by the milestone that
  introduced them (an internal convention from how this was built — see `.git log` for history; the
  tag itself doesn't matter to the runtime).

## The core principle: hub-and-spoke

```
              @wappy/core
             /     |      \
  @wappy/harness  @wappy/whatsapp  @wappy/create-agent
```

`@wappy/core` defines the interfaces everything else implements. The other packages depend on core
and nothing else, never on each other. This is enforced, not just a convention: see
`packages/e2e/src/arch.ts`, which scans every package's real imports and fails if a plugin ever
imports another plugin directly. If you're adding a new package, it either depends only on
`@wappy/core`, or it's orchestration code (like `create-agent` or the test suite) that's allowed to
wire multiple parts together.

## `@wappy/core`

**What:** The shared contracts. `Tool`/`ToolProvider`, `Memory`, `MessageChannel`,
`SessionProfileStore`, the `SmartMessage` schema, the plugin registry, and the install-state ledger
(`.wappy/state.json`, used by `create-agent` for resumable scaffolding).

**Why it's separate:** Every other package is swappable in principle (a different WhatsApp
provider, a different memory backend) as long as it satisfies these interfaces. Freezing them here,
with a snapshot test against `contracts/core.api.json` that fails on any breaking change, is what
makes that swap actually safe instead of aspirational.

**Start reading:** `packages/core/src/interfaces.ts` (the interfaces), `packages/core/src/schemas.ts`
(the zod schemas, especially `SmartMessageSchema` and `SessionProfileSchema`).

## `@wappy/harness`

**What:** The agent itself. `createAgent()` orchestrates one inbound message into one reply:
load memory and session profile, route (decide what kind of message this is), retrieve/invoke
whatever it needs, compose a reply, send it, persist the turn.

**Why it's shaped this way:**

- **Router-then-compose, not one big prompt.** `router.ts` is a cheap first pass ("does this need
  RAG? a tool? is it urgent?"); `compose-with-budget.ts` is the actual reply-generation call. A
  plain "hi" never touches the router's more expensive downstream paths. This is the "System
  One/System Two" split referenced in code comments.
- **Context budgeting, not truncation-by-luck.** `context-budget.ts` and `assemble.ts` build the
  prompt in a fixed, priority-ordered way (system prompt and the user's message are never dropped;
  everything else degrades gracefully under a token budget). See `assemble.ts`'s own `DROP_PRIORITY`
  for the exact order.
- **Format reasoning on every reply.** `agent.ts`'s `FORMAT_REASONING` constant is a fixed, zero-domain-language
  question series the model runs through on every single compose call, deciding text vs. buttons vs.
  list vs. link vs. media from the shape of the reply itself, not a hand-coded rule per use case.
- **Session profile (`session-profile.ts`), not just raw history.** A small, TTL-bound record of
  facts learned about a contact plus the live "current state" of the conversation right now,
  extracted for free from the same compose call that already decides the reply format. This is what
  makes a bare one-word reply interpretable days into a conversation.
- **Local RAG (`knowledge.ts`, `local-embedder.ts`).** `Knowledge.recall()` uses BM25 (lexical) by
  default; passing an `embed` function plus `embedDimensions` switches it to real vector search
  using LibSQL's native column type. `local-embedder.ts` is the one place `@huggingface/transformers`
  is imported.
- **Confirm-before-write (`confirm.ts`).** A tool marked `confirmBefore: true` doesn't run
  immediately. It's held pending, keyed to the specific confirmation request it was issued under, so
  a stale or duplicate "confirm" tap can never execute the wrong action, or the same action twice.
- **Everything degrades, nothing crashes the reply.** Almost every step in `agent.ts` is wrapped in a
  `safeCall`/`safeLoad`/`safeAppend` helper: a memory outage, a RAG failure, a tool timeout, none of
  it should cost the user their reply. Look at how consistently that pattern repeats before changing
  the error handling here.

**Start reading:** `packages/harness/src/agent.ts` (the orchestration, read top to bottom),
`packages/harness/src/compose-with-budget.ts`, `packages/harness/src/knowledge.ts`.

## `@wappy/whatsapp`

**What:** Everything about talking to the WhatsApp Cloud API correctly. Inbound webhook parsing,
outbound message rendering (`SmartMessage` → WhatsApp's actual JSON shapes), delivery retries, a
fallback ladder for when a rich message type fails, the 24-hour session-window rule, a real webhook
HTTP server.

**Why it's this detailed:** most of what's hard about a WhatsApp integration is Meta's own real API
behavior, which doesn't match what the docs imply. Every non-obvious rule here (empty
`interactive.body.text` gets rejected, header text has a real 60-character limit, the session window
genuinely blocks a free-form send) was found by making a real API call and observing what actually
happened, not by reading documentation. See `send/render.ts`, `send/constraints.ts`, and
`send/fallback.ts` for where that shows up.

**Start reading:** `packages/whatsapp/src/channel.ts` (the `MessageChannel` implementation),
`packages/whatsapp/src/send/orchestrator.ts` (the actual send pipeline: window check → render →
constrain → retry → fallback).

## `@wappy/create-agent`

**What:** The CLI (`npm create @wappy/agent`). A one-question interview (just the model provider,
currently), then a pure, deterministic template renderer (`templates.ts`) writes a runnable project,
and a ledger-driven generator (`generate.ts`) writes it to disk resumably (re-running after a
Ctrl-C only redoes what didn't finish).

**Why it's this narrow:** the interview used to ask about tools/connectors too. That's gone. A
generated project ships with zero tools wired in and a comment pointing at `@wappy/core`'s
`Tool`/`ToolProvider` interfaces, because domain-specific integrations (a store, a calendar,
anything else) don't belong in this repo. See "What this repo deliberately doesn't ship," below.

**Start reading:** `packages/create-wappy/src/interview.ts` (the state machine),
`packages/create-wappy/src/templates.ts` (what actually gets generated).

## What this repo deliberately doesn't ship

No domain connectors. No Shopify, no calendar integration, nothing tied to one business or use
case. `Tool`/`ToolProvider` in `@wappy/core` is the whole extension surface: build a tool over your
own API, an OpenAPI spec, MCP, Composio, whatever fits, in your own project, and hand it to
`createAgent({ tools, invokeTools })`. This repo's own test suite proves the harness works correctly
with zero tools and zero skills registered, specifically so this boundary stays real, not aspirational.

## Testing discipline, briefly

- `pnpm -w -r test` runs everything. `pnpm gate <n>` additionally checks: lint, typecheck, build,
  that older tests haven't been silently edited (`fix the code, not the test` is the rule; changing
  an old test requires an explicit reason), and a coverage ratchet that never lowers without a
  deliberate `--force`.
- Every package's tests avoid real network calls and real model calls: `@wappy/testkit` provides
  fakes/mocks (`mockModel`, `mockWhatsAppCloud`, `fakeMemory`, etc.) that satisfy the real interfaces.
- Where a real-world behavior mattered (a WhatsApp API rejection rule, a LibSQL vector query's exact
  syntax, a local embedding model's actual output), it was verified against the real thing at least
  once, separately from the mocked test suite, before being encoded as a rule. If you're adding
  something similar, do the same: don't assume an external API's behavior, check it.
