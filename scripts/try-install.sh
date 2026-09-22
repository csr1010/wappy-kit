#!/usr/bin/env bash
# Simulates a stranger installing Wappy Kit from tarballs (nothing is published yet).
# Usage: scripts/try-install.sh [sandbox-dir]   (default: ~/wappy-sandbox)
# Then follow the printed commands to run the interview yourself in a real terminal.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BOX="${1:-$HOME/wappy-sandbox}"
rm -rf "$BOX" && mkdir -p "$BOX/tarballs" "$BOX/installer"
cd "$ROOT" && pnpm exec turbo run build --output-logs=errors-only
for p in core harness whatsapp tools-openapi create-wappy; do
  (cd "packages/$p" && pnpm pack --pack-destination "$BOX/tarballs" >/dev/null)
done
cd "$BOX/installer" && npm init -y >/dev/null && npm install --no-audit --no-fund "$BOX"/tarballs/*.tgz
echo
echo "Installed into $BOX/installer. Run the interview in a real terminal:"
echo "  cd $BOX && ./installer/node_modules/.bin/create-wappy --dir my-agent"
