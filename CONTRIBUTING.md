# Contributing to Wappy Kit

Thanks for looking at this. It's early and genuinely pre-1.0, so the shape of things can still
move, but real contributions are welcome: bug reports, "this broke on my machine," small fixes,
and bigger changes if you talk through the design first.

## Before you start

Read [`ARCHITECTURE.md`](ARCHITECTURE.md). It's written for exactly this situation - a human or an
AI coding agent picking the repo up cold - and explains what each package does, why it's built the
way it is, and where to start reading. Don't skip it; a lot of "why is this so convoluted" questions
are answered there.

## Setup

```bash
git clone https://github.com/csr1010/wappy-kit.git
cd wappy-kit
pnpm install
pnpm -w -r build
pnpm -w -r test
```

Requires Node.js 20+ and pnpm (see the `packageManager` field in `package.json` for the pinned
version).

## Ground rules

- **Hub-and-spoke is enforced, not a suggestion.** `@wappy/core` has no dependents that import each
  other; `packages/e2e/src/arch.ts` scans real imports and fails the build if that's ever violated.
- **Fix the code, not the test.** Existing tests are treated as a spec. If a test looks wrong,
  that's worth raising, but changing or deleting one needs a real reason stated in the PR, not a
  silent edit.
- **No real network calls in tests.** `@wappy/testkit` has fakes for the model, WhatsApp, memory,
  etc. Use them.
- **Small, focused PRs** are much easier to review than one that touches five things. If you're not
  sure whether an idea fits, open an issue first and we can talk it through before you write code.

## What doesn't belong here

Domain-specific integrations (a store, a calendar, a CRM, anything tied to one business or one use
case) are intentionally out of scope for this repo - see "What this repo deliberately doesn't ship"
in `ARCHITECTURE.md`. Those belong in your own project, built on `@wappy/core`'s
`Tool`/`ToolProvider` interfaces.

## Reporting security issues

Do not open a public issue for a security vulnerability. See [`SECURITY.md`](SECURITY.md).

## Code of conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
