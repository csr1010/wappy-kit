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
PRESERVE_ENV=0
while [ $# -gt 0 ]; do
  case "$1" in
    --interview-args) INTERVIEW_ARGS="$2"; shift 2 ;;
    --registry-dir) REGISTRY_DIR="$2"; shift 2 ;;
    --sandbox-dir) SANDBOX="$2"; shift 2 ;;
    --preserve-env) PRESERVE_ENV=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
NPMRC="$REGISTRY_DIR/.npmrc"
STAGE="$SANDBOX/.preserved-env"

# --preserve-env: before wiping the old project, save any real (non-placeholder) values already
# sitting in its .env and .env.sample — WhatsApp creds, a model API key, a working Shopify token —
# so a clean reinstall doesn't force you to re-enter them. Values are staged to a 600-mode file and
# never printed. CLAUDE_API_KEY (a natural but wrong name to hand-type) is remapped to the real
# ANTHROPIC_API_KEY the generated code actually reads.
if [ "$PRESERVE_ENV" = "1" ] && [ -d "$SANDBOX/verdaccio-project" ]; then
  echo "== preserving real env values from the old project (values not shown)"
  PROJ="$SANDBOX/verdaccio-project" STAGE="$STAGE" node -e '
    const fs = require("fs");
    function readEnv(path) {
      if (!fs.existsSync(path)) return {};
      const out = {};
      for (const line of fs.readFileSync(path, "utf8").split("\n")) {
        const m = /^([A-Z_]+)=(.+)$/.exec(line.trim());
        if (m) out[m[1]] = m[2];
      }
      return out;
    }
    const sample = readEnv(process.env.PROJ + "/.env.sample");
    const env = readEnv(process.env.PROJ + "/.env");
    const out = {};
    for (const k of ["WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_VERIFY_TOKEN", "WHATSAPP_APP_SECRET"]) {
      if (sample[k]) out[k] = sample[k]; else if (env[k]) out[k] = env[k];
    }
    for (const [alias, real] of [["CLAUDE_API_KEY", "ANTHROPIC_API_KEY"], ["OPENAI_API_KEY", "OPENAI_API_KEY"], ["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"], ["GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"]]) {
      if (sample[alias]) out[real] = sample[alias];
      else if (env[real]) out[real] = env[real];
    }
    for (const k of ["SHOPIFY_STORE_DOMAIN", "SHOPIFY_ACCESS_TOKEN"]) {
      if (env[k]) out[k] = env[k]; else if (sample[k]) out[k] = sample[k];
    }
    fs.writeFileSync(process.env.STAGE, Object.entries(out).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
    console.log("staged keys:", Object.keys(out).join(", ") || "(none found)");
  '
fi

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

if [ "$PRESERVE_ENV" = "1" ] && [ -s "$STAGE" ]; then
  echo "== restoring preserved values into the fresh .env (values not shown)"
  cp "$SANDBOX/verdaccio-project/.env.sample" "$SANDBOX/verdaccio-project/.env"
  PROJ="$SANDBOX/verdaccio-project" STAGE="$STAGE" node -e '
    const fs = require("fs");
    const staged = fs.readFileSync(process.env.STAGE, "utf8").split("\n").filter(Boolean)
      .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; });
    let env = fs.readFileSync(process.env.PROJ + "/.env", "utf8");
    for (const [k, v] of staged) {
      const re = new RegExp("^" + k + "=.*$", "m");
      env = re.test(env) ? env.replace(re, `${k}=${v}`) : env + `\n${k}=${v}\n`;
    }
    fs.writeFileSync(process.env.PROJ + "/.env", env);
    console.log("restored:", staged.map(([k]) => k).join(", "));
  '
fi

echo
echo "Done. Project at: $SANDBOX/verdaccio-project"
if [ "$PRESERVE_ENV" != "1" ]; then
  echo "Next: cp .env.sample .env, fill it in, then boot the app (once T9.7's server exists)."
fi
