# Generated-project snapshots (B7)

Frozen output of `create-wappy`, one folder per release and answer combination
(`create-wappy-<version>-<combo>/`). `packages/e2e/src/old-projects.m16.test.ts` boots each
one against the current `@wappy_ai/*` packages and checks that it answers a message, so an upgrade
never breaks a project someone already generated.

Append-only, like every fixture: when a create-wappy release changes what it generates, add new
folders for that version. Never edit or delete an old one: those are the projects people have.
