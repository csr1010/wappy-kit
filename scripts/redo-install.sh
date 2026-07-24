#!/usr/bin/env bash
# Clean-slate reinstall through the real registry (Verdaccio): rebuild every package, republish
# each one fresh, reinstall create-wappy, regenerate a project, and install ITS dependencies too —
# the exact step that a tarball-only test can't reach. Run this after any bug fix.
#
# Usage: scripts/redo-install.sh [--interview-args "..."] [--registry-dir DIR] [--sandbox-dir DIR]
#   --interview-args   flags for the non-interactive interview (default below: Shopify + both skills)
# Requires a Verdaccio instance already running at $REGISTRY (see docs/PROGRESS.md for how this
# session started one: `npx verdaccio` against a storage dir under the sandbox).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REGISTRY="${REGISTRY:-http://127.0.0.1:4873}"
REGISTRY_DIR="${REGISTRY_DIR:-$HOME/wappy-sandbox/verdaccio}"
SANDBOX="${SANDBOX_DIR:-$HOME/wappy-sandbox}"
INTERVIEW_ARGS="--yes --model openai --api shopify --skills store-info,orders"
while [ $# -gt 0 ]; do
  case "$1" in
    --interview-args) INTERVIEW_ARGS="$2"; shift 2 ;;
    --registry-dir) REGISTRY_DIR="$2"; shift 2 ;;
    --sandbox-dir) SANDBOX="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
NPMRC="$REGISTRY_DIR/.npmrc"

curl -fsS "$REGISTRY/-/ping" >/dev/null 2>&1 || { echo "Verdaccio isn't reachable at $REGISTRY — start it first."; exit 1; }
[ -f "$NPMRC" ] || { echo "No auth token at $NPMRC — log in once (see docs/PROGRESS.md)."; exit 1; }
TOKEN=$(grep -o '"[^"]*"' "$NPMRC" | tr -d '"')

echo "== 1/6 clearing prior state (registry storage for our packages + sandbox install dirs)"
rm -rf "$REGISTRY_DIR/storage/@wappy" "$REGISTRY_DIR/storage/create-wappy"
rm -rf "$SANDBOX/verdaccio-install" "$SANDBOX/verdaccio-project"
npm cache clean --force --userconfig "$NPMRC" >/dev/null 2>&1 || true

echo "== 2/6 building every package fresh"
cd "$ROOT" && pnpm exec turbo run build --force --output-logs=errors-only

echo "== 3/6 publishing to the local registry (pnpm, so workspace:* resolves to real versions)"
for p in core harness whatsapp tools-openapi create-wappy; do
  (cd "$ROOT/packages/$p" && pnpm publish --no-git-checks --access public --registry "$REGISTRY" --config."//127.0.0.1:4873/:_authToken"="$TOKEN" 2>&1 | grep -E "Published|Error" || true)
done

echo "== 4/6 installing create-wappy the way a real user would (npm install, from the registry)"
mkdir -p "$SANDBOX/verdaccio-install" && cd "$SANDBOX/verdaccio-install"
npm init -y >/dev/null
npm install create-wappy --registry "$REGISTRY" --userconfig "$NPMRC" --silent

echo "== 5/6 running the real installed CLI ($INTERVIEW_ARGS)"
# shellcheck disable=SC2086
./node_modules/.bin/create-wappy $INTERVIEW_ARGS --dir "$SANDBOX/verdaccio-project"

echo "== 6/6 installing the generated project's own dependencies (the step that used to 404)"
cd "$SANDBOX/verdaccio-project"
npm install --registry "$REGISTRY" --userconfig "$NPMRC" --silent

echo
echo "Done. Project at: $SANDBOX/verdaccio-project"
echo "Next: cp .env.sample .env, fill it in, then boot the app (once T9.7's server exists)."
