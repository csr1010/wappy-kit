## What this does

A short description of the change and why.

## Checklist

- [ ] I read [`ARCHITECTURE.md`](../ARCHITECTURE.md) and this change respects the hub-and-spoke
      boundaries (no plugin package imports another plugin package).
- [ ] `pnpm -w -r build && pnpm -w -r test` passes locally.
- [ ] If I changed an existing test, I explained why in this description (not just "fixed test").
- [ ] New behavior has test coverage; no real network calls were added to any test.

## Related issue

Closes #
