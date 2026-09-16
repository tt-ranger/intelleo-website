#!/usr/bin/env bash
# Run the same steps as .github/workflows/quality-gate.yml, locally.
#
# Uses the Node version CI uses, not whatever is on PATH. A mismatch between
# local Node 20 and CI Node 22 is what let a broken test command reach CI
# once already, so the version is pinned here deliberately.
#
#   ./scripts/ci-local.sh            # offline: skips live citation checks
#   ./scripts/ci-local.sh --online   # full gate, exactly as CI runs it
set -euo pipefail
cd "$(dirname "$0")/.."

NODE_VERSION=22
ONLINE=${1:-}

if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh"
  nvm use "$NODE_VERSION" >/dev/null 2>&1 || {
    echo "Node $NODE_VERSION not installed. Run: nvm install $NODE_VERSION"; exit 1; }
fi

echo "node $(node --version)  (CI uses $NODE_VERSION)"
step() { printf '\n=== %s ===\n' "$1"; }

step "install"
# `npm ci` deletes node_modules wholesale. A running dev server holds file
# handles in there and the delete fails halfway, leaving a broken install.
if pgrep -f "[a]stro dev" >/dev/null 2>&1; then
  echo "A dev server is running and npm ci would corrupt node_modules."
  echo "Stop it first (Ctrl-C in its terminal), then re-run."
  exit 1
fi
npm ci --no-audit --no-fund >/dev/null
echo "ok"

step "unit tests"
node --test scripts/__tests__/*.test.mjs 2>&1 | grep -E '^# (tests|pass|fail)'

step "quality gate"
if [ "$ONLINE" = "--online" ]; then
  node scripts/quality-gate.mjs
else
  echo "(offline — pass --online to verify citation URLs)"
  node scripts/quality-gate.mjs --offline
fi

step "build"
npm run build 2>&1 | grep -E 'page\(s\) built|error'

printf '\nAll CI steps passed.\n'
