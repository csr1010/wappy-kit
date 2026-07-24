# PROGRESS — handoff log (READ FIRST on session resume)

Rewrite the **Current handoff** block at the end of every session. Keep it under 40 lines. Append to the Decision & change log; never delete entries.

## Current handoff

- **Date:** 2026-09-20
- **Milestone / task:** M0 in progress (T0.1–T0.3 done; T0.4–T0.8 next)
- **Last green gate:** none. `pnpm gate 0` currently fails ONLY on missing M0 mechanisms (testkit, e2e, ratchet, arch test); lint/typecheck/build/tests are green.
- **Repo:** https://github.com/csr1010/wappy-kit (private). Commit `2a11f34` = scaffold. `main` tracks `origin/main`.
- **Files in flight (uncommitted):** docs/, scripts/gate.mjs, scripts/ctx.mjs, CLAUDE.md, package.json (scripts + packageManager), renamed index.m0.test.ts files.
- **Next 3 actions:**
  1. Commit the docs/scripts work, then T0.4 `packages/testkit`.
  2. T0.5 `packages/e2e`, T0.6 arch guard test, T0.7 coverage ratchet.
  3. `pnpm gate 0` green → `git tag m0-done` → `pnpm ctx M1`.
- **Open decisions:** license (MIT vs Apache-2.0), tunnel provider for `wappy dev`, Shopify API flavor (Admin GraphQL vs REST) — see milestone files M11/M9/M8.
- **Gotchas:** pnpm here is v12.5.1 (no `-s`, different recursive flags) — gate loops packages itself. Added `packageManager` to root package.json (turbo + CI need it). `gh` installed at `~/.local/bin/gh` (not on PATH by default). Repo is private until M11 (spec §15.2 says public).

## Decision & change log

- 2026-09-20: Spec saved to docs/SPEC.md; milestones M0–M11 defined; backward-testing layers B1–B10 defined (see MILESTONES.md).
- 2026-09-20: Proposed spec additions, to be ratified in M1 T1.1 (record in SPEC §16 then): (a) `Tracer` added to core contracts — needed for §9 "trace" and spine tests; (b) `Skill` added to core contracts — §13/§17 treat it as a core interface but §3 omits it; (c) RAG/`Knowledge` module lives in harness — §9-B needs it but no part owns it.
