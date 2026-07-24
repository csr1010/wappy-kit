# PROGRESS — handoff log (READ FIRST on session resume)

Rewrite the **Current handoff** block at the end of every session. Keep it under 40 lines. Append to the Decision & change log; never delete entries.

## Current handoff

- **Date:** 2026-09-20
- **Milestone / task:** M0 DONE (T0.1-T0.8). Tag `m0-done`. M1 not started.
- **Last green gate:** `pnpm gate 0` PASS (lint, typecheck, build, tests m0, coverage ratchet).
- **Repo:** https://github.com/csr1010/wappy-kit (private). `main` tracks `origin/main`.
- **Next 3 actions:**
  1. `pnpm ctx M1`, then T1.1 (ratify spec additions: Tracer, Skill, Knowledge in SPEC section 16).
  2. Bump CI step to `pnpm gate 1` when M1 lands (see .github/workflows/ci.yml).
  3. Create scripts/contract.mjs + contracts/core.api.json as M1 requires (gate n>=1 needs them).
- **Open decisions:** license (MIT vs Apache-2.0), tunnel provider for `wappy dev`, Shopify API flavor (Admin GraphQL vs REST) - see milestone files M11/M9/M8.
- **Gotchas:** pnpm here is v12.5.1 (no `-s`). TS 6 has no default `types`: packages using node APIs need `"types": ["node"]` in tsconfig (testkit/e2e do). testkit API is documented in the header of packages/testkit/src/index.ts - do not open its internals. Arch guard + ratchet tests live in packages/e2e (scripts/ratchet.mjs, coverage-baseline.json; `pnpm ratchet` only raises the baseline). `gate.m0.test.ts` (listed in M0 brief) was not among T0.4-T0.8 and does not exist yet. `gh` at `~/.local/bin/gh`. Repo stays private until M11.

## Decision & change log

- 2026-09-20: Spec saved to docs/SPEC.md; milestones M0–M11 defined; backward-testing layers B1–B10 defined (see MILESTONES.md).
- 2026-09-20: Proposed spec additions, to be ratified in M1 T1.1 (record in SPEC §16 then): (a) `Tracer` added to core contracts — needed for §9 "trace" and spine tests; (b) `Skill` added to core contracts — §13/§17 treat it as a core interface but §3 omits it; (c) RAG/`Knowledge` module lives in harness — §9-B needs it but no part owns it.
