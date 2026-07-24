# Wappy Kit — Milestones (v0.1)

Derived from [SPEC.md](SPEC.md) v2.0. One file per milestone in [milestones/](milestones/). Progress lives in [PROGRESS.md](PROGRESS.md).

## Milestone map

| # | Milestone | Spec | Depends on | Proves |
|---|-----------|------|------------|--------|
| M0 | Test harness, gates, guardrails | §2, §12 | — | We can *detect* regressions before writing features |
| M1 | Core contracts + registry + tracer | §3, §15.1 | M0 | Every part can be built against frozen interfaces |
| M2 | Install-state ledger | §5 | M1 | Installs are resumable, lockable, migratable |
| M3 | WhatsApp inbound + reliability base | §6.2 | M1 | Forged/duplicate/odd webhooks never break us |
| M4 | WhatsApp smart send + fallback | §6.1, §6.2, §6.3 | M1, M3 | Every SmartMessage is delivered or degrades |
| M5 | Harness: agent loop, memory, router, skills | §7, §9-A | M1 | Scenario A ("hi") end-to-end with mocks |
| M6 | Context management (large contexts) | §10 | M5 | No prompt ever overflows; big inputs/outputs are bounded |
| M7 | tools-openapi engine | §8 | M1, M6 | Any OpenAPI spec → safe, bounded tools |
| M8 | Shopify connector, RAG, reference skills | §8, §9-B/C, §15.4 | M5–M7 | Scenarios B and C end-to-end |
| M9 | create-wappy CLI | §4, §12 | M2, M4–M8 | One command → runnable project |
| M10 | Optional backends (Jev, Mem0, Cognee, Postgres) | §7, §15.3 | M5, M9 | Swappability holds; conformance suites pass |
| M11 | Integration, release hardening, live check | §11, §12, §14 | all | v0.1.0 is publishable |

Parallelism: after M1, **M2, M3→M4, M5→M6, M7** are independent tracks (they touch different packages). M8 needs M5–M7. M9 needs everything it wires. Single-session default: go in numeric order.

## The loop (every milestone, every session)

```
pnpm ctx M<n>          # prints the brief + only the spec sections it needs (NOT the whole spec)
# work one task (T<n>.<k>) at a time: test first -> implement -> pnpm gate <n> --quick
git commit             # one commit per task, message "M<n> T<n>.<k>: ..."
# after last task:
pnpm gate <n>          # FULL cumulative gate (below). Must be green.
git tag m<n>-done      # baseline for backward checks
# update docs/PROGRESS.md (handoff block) and commit
```

A milestone is **done** only when `pnpm gate <n>` exits 0 *and* the tag exists. Never start M(n+1) on a red gate.

## Test naming & where things live

- Tests: `<name>.m<N>.test.ts` next to the code (N = milestone that introduced the test). The tag is how the gate selects suites; **untagged tests are rejected** by the gate.
- Cross-package tests: `packages/e2e/` (spine + generated-project tests). Shared mocks/fakes/conformance suites: `packages/testkit/` (private, dev-only; parts may depend on it only as a devDependency).
- Fixtures are **append-only** under `fixtures/` (see B4).
- No test touches the real network, real clock (inject `Clock`), real `$HOME` (use `tmpProject()`), or a TTY.

## Backward-testing strategy (regression layers)

Each layer catches a different kind of "new work broke old work". All run in `pnpm gate <n>`.

| # | Layer | Catches | Mechanism |
|---|-------|---------|-----------|
| B1 | **Cumulative suites** | Behavior regressions | Gate runs every test tagged `m0..m<n>`, not just `m<n>` |
| B2 | **Test immutability** | "Fixed" a regression by editing/deleting the old test | Gate diffs `*.test.ts`/`fixtures/` against tag `m<n-1>-done`: deletions/modifications fail unless `--allow-test-change "<reason>"` (reason is appended to PROGRESS.md decision log) |
| B3 | **Contract snapshot** (from M1) | Breaking `@wappy/core` API | `contracts/core.api.json` extracted from `.d.ts`; removals/changes fail, additions need `pnpm contract:update` + Decisions Log line. Strict-semver in practice |
| B4 | **Append-only fixtures** | Parser/schema/format drift | `fixtures/state/v*.json` (every ledger schema version must still load+migrate), `fixtures/whatsapp/{inbound,outbound}/*.json` (recorded Cloud API shapes), `fixtures/openapi/*` (+ golden tool snapshots), `fixtures/generated/<milestone>-<combo>/` (scaffold output) |
| B5 | **Spine tests** (from M5) | Cross-part wiring regressions | The 3 canonical traces (A hi / B hours / C order) run at *every* later milestone with the strongest wiring available; each asserts the exact set of systems touched (§9) |
| B6 | **Contract conformance suites** (from M1) | An implementation drifting from its interface | `runChannelConformance`, `runMemoryConformance`, `runRouterConformance`, `runToolProviderConformance` in testkit; every impl (fake, real, optional backend) must pass the same suite |
| B7 | **Old-project compatibility** (from M9) | New CLI/runtime breaking already-generated projects | Snapshotted generated projects in `fixtures/generated/` must still typecheck, boot and answer scenario A against current packages; `wappy status/doctor` must read their old `state.json` |
| B8 | **Coverage ratchet** | Silent test erosion | `coverage-baseline.json` per package; gate fails if coverage drops; `pnpm ratchet` raises it |
| B9 | **Architecture guard** | Hub-and-spoke violations | Test asserts: core imports no plugin; plugins import only core; no plugin↔plugin dependency; CLI is the only orchestrator |
| B10 | **Fresh-install check** (M11) | Works on my machine | Pack tarballs, install into empty dir, run the CLI + spine, Node 20/22/24 |

Rule of thumb when a backward test fails: **fix the code, not the test.** If the old behavior was truly wrong, that is a spec change → update SPEC.md + Decisions Log, then use `--allow-test-change`.

## Large-context handling

### A. Building sessions (agent/dev context is finite)

- **Never load the whole spec.** `pnpm ctx M<n>` prints the milestone brief plus only the §-sections it lists. Each brief is ≤ ~120 lines and self-contained.
- **One task per commit, one milestone per session (or less).** A session may stop after any task; state is recoverable from git + PROGRESS.md.
- **PROGRESS.md handoff block** (fixed schema) is rewritten at the end of every session: current milestone/task, last green gate, files in flight, next 3 actions, open decisions, gotchas. A cold session needs only: `PROGRESS.md` → `pnpm ctx M<n>`.
- **Quiet tooling.** `pnpm gate` prints one line per step and only the tail of failing output (last ~60 lines). Do not paste full logs; never read `pnpm-lock.yaml`, `node_modules`, `dist`, or `fixtures/openapi/huge-*` (synthetic, thousands of lines) into context — inspect with `head`, `jq`, or the golden summaries.
- **Small files.** One responsibility per module, target < 300 lines; split before a file needs paging. Interfaces live in `@wappy/core`, so a session touching `whatsapp` never needs `harness` source.
- **Decisions are written down once** (SPEC §16 or PROGRESS), not re-litigated per session.

### B. The product (the agent's context is finite too)

Handled explicitly, not incidentally:

| Risk (§10) | Where | Mitigation |
|---|---|---|
| Long conversation history | M6 | `ContextBudget` + windowing + rolling summary persisted in memory; system/skill prefix kept stable |
| Too many tools | M6/M7/M8 | Curation at install, read-only default, runtime `ToolSelector` (lexical default; embeddings optional) |
| Huge tool responses | M6/M7 | Response size cap → truncate + structured summary; never feed raw megabytes to the model |
| Huge inbound message/caption | M6 | Truncation policy with honest notice |
| Provider says "context too long" | M6 | Shrink budget and retry once, then degrade to honest message |
| Huge OpenAPI spec (Shopify-scale, 800+ ops) | M7 | Streaming-safe parse, skip report, `max` curation, synthetic 800-op fixture in tests |
| Token accounting | M6 | Pluggable estimator (conservative chars/4 fallback), per-message token trace |

## Definition of done (every milestone)

1. All tasks checked in the milestone file. 2. `pnpm gate <n>` green (B1–B9 as applicable). 3. `git tag m<n>-done`. 4. PROGRESS.md handoff updated. 5. Any spec change recorded in SPEC.md §16 with a version bump.
