# PROGRESS — handoff log (READ FIRST on session resume)

Rewrite the **Current handoff** block at the end of every session. Keep it under 40 lines. Append to the Decision & change log; never delete entries.

## Current handoff

- **Date:** 2026-09-21
- **Milestone / task:** M1 DONE (T1.1-T1.8). Tag `m1-done`. M2 not started.
- **Last green gate:** `pnpm gate 1` PASS (lint, typecheck, build, tests m0..m1, B2 immutability, B3 contract snapshot, B8 coverage ratchet). Code-reviewed (clean) + manual use-case sanity check (scenario A traced end-to-end through PluginRegistry/Tracer/SmartMessage, touched-systems assertion, guardrail checks) — see session transcript.
- **Repo:** https://github.com/csr1010/wappy-kit (private) per SPEC, but **this session's sandbox has no `origin` remote and no GitHub credentials configured** — `git remote -v` is empty, `gh` is not installed. All M1 commits + the `m1-done` tag exist only locally in this container. Asked the user for a remote URL + push-capable token; push is pending that. `main` should track `origin/main` once wired up.
- **Next 3 actions:**
  1. Once a remote/token is provided: `git remote add origin <url>`, push `main` + tag `m1-done`.
  2. `pnpm ctx M2`, then T2.1 (install-state ledger, SPEC §5) — `.wappy/state.json` schema, idempotent steps, lock file.
  3. Bump CI step to `pnpm gate 2` when M2 lands (already at `pnpm gate 1` for M1).
- **Open decisions:** license (MIT vs Apache-2.0), tunnel provider for `wappy dev`, Shopify API flavor (Admin GraphQL vs REST) - see milestone files M11/M9/M8. New: git push destination/credentials for this build (asked user 2026-09-21, awaiting reply).
- **Gotchas:** pnpm here is v12.5.1 (no `-s`). TS 6 has no default `types`: packages using node APIs need `"types": ["node"]` in tsconfig (testkit/e2e do). testkit API is documented in the header of packages/testkit/src/index.ts - do not open its internals (M1 added fakeChannel/fakeMemory/fakeRouter/fakeToolProvider + run*Conformance to it). Arch guard + ratchet tests live in packages/e2e (scripts/ratchet.mjs, coverage-baseline.json; `pnpm ratchet` only raises the baseline). `gate.m0.test.ts` (listed in M0 brief) was not among T0.4-T0.8 and does not exist yet. `gh` is not installed in this sandbox at all (not just off PATH). Repo stays private until M11. **Sandbox quirk:** on a fresh container, `turbo run build/typecheck` can fail 100% of the time with `Exec format error (os error 8)` because pnpm's self-managed binary at `~/.local/share/pnpm/.tools/pnpm/<ver>/node_modules/pnpm/pnpm` is a shebang-less shell placeholder until its own `install.js` runs (turbo execve's it directly, which doesn't get the shell-fallback retry a normal shim/shell would); fix once per container: `node ~/.local/share/pnpm/.tools/pnpm/<ver>/node_modules/pnpm/install.js`. Core's per-package `typecheck` script now points at `tsconfig.typecheck.json` (includes `*.test.ts`, still `--noEmit`) so `expectTypeOf` tests actually get checked — other packages still exclude tests from typecheck (M0 pattern); adopt the same fix there if/when they grow type-level tests. Per explicit user instruction this session (see CLAUDE.md step 4 note), every milestone now ends with a code review pass + a manual use-case sanity check + a push to `main`, not just the gate.

## Decision & change log

- 2026-09-20: Spec saved to docs/SPEC.md; milestones M0–M11 defined; backward-testing layers B1–B10 defined (see MILESTONES.md).
- 2026-09-20: Proposed spec additions, to be ratified in M1 T1.1 (record in SPEC §16 then): (a) `Tracer` added to core contracts — needed for §9 "trace" and spine tests; (b) `Skill` added to core contracts — §13/§17 treat it as a core interface but §3 omits it; (c) RAG/`Knowledge` module lives in harness — §9-B needs it but no part owns it.
