#!/usr/bin/env bash
# test-compat.sh — run integration tests against multiple pi versions.
#
# Discovers the latest patch release for the last N minor versions of
# @mariozechner/pi-coding-agent from the npm registry, installs each with
# --no-save (so package.json is untouched), runs the mock-server integration
# tests (no API key required), then restores the original lockfile via npm ci.
#
# Usage:
#   bash scripts/test-compat.sh          # test last 3 minor versions (default)
#   bash scripts/test-compat.sh 5        # test last 5 minor versions
#   SKIP_E2E=1 bash scripts/test-compat.sh  # skip bash e2e tests

set -euo pipefail

PACKAGE="@mariozechner/pi-coding-agent"
N_MINORS="${1:-3}"
SKIP_E2E="${SKIP_E2E:-}"

# ── Resolve target versions ──────────────────────────────────────────────────

echo "Fetching published versions of ${PACKAGE}..."
VERSIONS=$(node -e "
const { execSync } = require('child_process');
const raw = execSync('npm show ${PACKAGE} versions --json 2>/dev/null').toString();
const all = JSON.parse(raw);
const byMinor = {};
all.forEach(v => {
  const parts = v.split('.');
  const key = parts[0] + '.' + parts[1];
  byMinor[key] = v; // last one wins = latest patch of that minor
});
const latest = Object.values(byMinor);
console.log(latest.slice(-${N_MINORS}).join(' '));
")

if [ -z "$VERSIONS" ]; then
  echo "ERROR: could not resolve versions from npm" >&2
  exit 1
fi

echo "Target versions: ${VERSIONS}"
echo ""

# ── Save lockfile for restoration ────────────────────────────────────────────

LOCK_BACKUP=$(mktemp)
cp package-lock.json "$LOCK_BACKUP"

restore() {
  echo ""
  echo "Restoring original lockfile..."
  cp "$LOCK_BACKUP" package-lock.json
  rm -f "$LOCK_BACKUP"
  npm ci --silent 2>&1 | tail -3
  echo "Restored."
}
trap restore EXIT

# ── Per-version test loop ─────────────────────────────────────────────────────

declare -A RESULTS
SEP="────────────────────────────────────────"

for VERSION in $VERSIONS; do
  echo "$SEP"
  echo "  pi@${VERSION}"
  echo "$SEP"

  if ! npm install "${PACKAGE}@${VERSION}" --no-save --legacy-peer-deps --silent 2>&1; then
    echo "  ✗ SKIP  (install failed)"
    RESULTS[$VERSION]="SKIP"
    continue
  fi

  # Confirm installed version.
  INSTALLED=$(node -e "console.log(require('./node_modules/${PACKAGE}/package.json').version)" 2>/dev/null || echo "?")
  echo "  Installed: ${INSTALLED}"

  LOG=$(mktemp)
  FAILED=false

  if [ -z "$SKIP_E2E" ]; then
    echo -n "  e2e (bash)        ... "
    if bash e2e-tests/run.sh >"$LOG" 2>&1; then
      echo "✓"
    else
      echo "✗"
      FAILED=true
    fi
  fi

  echo -n "  integration/mock  ... "
  if npx vitest run test/integration/mock-server.test.ts --reporter=verbose >>"$LOG" 2>&1; then
    echo "✓"
  else
    echo "✗"
    FAILED=true
  fi

  if $FAILED; then
    RESULTS[$VERSION]="FAIL"
    echo ""
    echo "  ── captured output ──"
    # Show only the relevant failure lines to avoid noise.
    grep -E "( × | FAIL |Error:|TypeError:|AssertionError:|✗ )" "$LOG" | sed 's/^/  /' || cat "$LOG" | tail -30 | sed 's/^/  /'
  else
    RESULTS[$VERSION]="PASS"
  fi

  rm -f "$LOG"
  echo ""
done

# ── Summary ───────────────────────────────────────────────────────────────────

echo "════════════════════════════════════════"
echo "  Compatibility matrix"
echo "════════════════════════════════════════"
ALL_PASS=true
for VERSION in $VERSIONS; do
  STATUS="${RESULTS[$VERSION]:-???}"
  if [ "$STATUS" = "PASS" ]; then
    echo "  ✓  pi@${VERSION}"
  elif [ "$STATUS" = "SKIP" ]; then
    echo "  -  pi@${VERSION}  (install failed)"
    ALL_PASS=false
  else
    echo "  ✗  pi@${VERSION}"
    ALL_PASS=false
  fi
done
echo "════════════════════════════════════════"

if $ALL_PASS; then
  exit 0
else
  exit 1
fi
