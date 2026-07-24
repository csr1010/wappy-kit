# Wappy Kit — session protocol

Open-source WhatsApp Agent OS (pnpm + turbo monorepo). Spec: `docs/SPEC.md`. Plan: `docs/MILESTONES.md`.

## On every session start
1. Read `docs/PROGRESS.md` (the "Current handoff" block).
2. `pnpm ctx M<n>` for the current milestone — prints the brief + only the spec sections it cites. Do **not** read the whole spec.
3. Work one task (`T<n>.<k>`) at a time: test first, implement, `pnpm gate <n> --quick`, one commit `M<n> T<n>.<k>: ...`.
4. Finish a milestone with `pnpm gate <n>` (full, cumulative incl. backward checks) → code review the milestone's diff → a use-case sanity check (run the relevant scenario/CLI path for real, not just the automated suite) → `git tag m<n>-done` → update PROGRESS.md → push `main` (bump `.github/workflows/ci.yml`'s gate number to `<n>` first) → commit + push that too. (Push-to-main-per-milestone is explicit user instruction, 2026-09-21 session — narrower than the irreversible-action rule below; if push credentials/remote are ever missing, stop and ask rather than silently skipping.)

## Rules
- Tests are named `*.m<N>.test.ts` (N = milestone that introduced it). Untagged tests fail the gate.
- Fix the code, not old tests. Editing/deleting old tests or fixtures requires a spec change + `--allow-test-change "<reason>"`.
- Fixtures are append-only. Never edit `contracts/core.api.json` by hand (`pnpm contract:update`).
- Hub-and-spoke: core imports no plugin; plugins import only `@wappy/core`; only the CLI/e2e wire parts together.
- Keep context small: don't open `pnpm-lock.yaml`, `node_modules`, `dist`, or `fixtures/openapi/huge-*`; files < ~300 lines.
- Spec changes: edit `docs/SPEC.md` in place, bump version, add a Decisions Log line.
- Outward-facing/irreversible actions (making the repo public, npm publish) need explicit user approval in that session.
- `gh` lives at `~/.local/bin/gh` (may not be on PATH).
