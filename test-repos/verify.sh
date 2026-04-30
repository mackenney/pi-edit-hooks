#!/usr/bin/env bash
# verify.sh — validate test fixtures and core logic for pi-edit-hooks
# Dependencies: node (v22+ with native TypeScript strip support), jq

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

PASS=0; FAIL=0
pass() { printf '\033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
fail() { printf '\033[31m✗\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }

# ── 1. Config JSON Validation ─────────────────────────────────────────────────

echo "=== 1. Config JSON Validation ==="

while IFS= read -r -d '' f; do
  rel="${f#"$SCRIPT_DIR/"}"
  if jq . "$f" >/dev/null 2>&1; then
    pass "$rel — valid JSON"
  else
    fail "$rel — invalid JSON"
  fi
done < <(find "$SCRIPT_DIR" -name 'edit-hooks.json' -path '*/.pi/*' -print0)

# ── 2. Glob Matching ──────────────────────────────────────────────────────────

echo ""
echo "=== 2. Glob Matching ==="

test_glob() {
  local pattern="$1" file="$2" expected="$3"
  local result
  result=$(node --input-type=module << EOF 2>&1 || echo "ERROR"
import { matchesGlob } from '${PROJECT_ROOT}/src/glob.ts'
console.log(matchesGlob('${file}', '${pattern}'))
EOF
)
  if [[ "$result" == "$expected" ]]; then
    pass "glob '${pattern}' vs '${file}' → ${expected}"
  else
    fail "glob '${pattern}' vs '${file}': expected ${expected}, got ${result}"
  fi
}

test_glob "*.py"           "src/app.py"  "true"
test_glob "*.py"           "src/app.ts"  "false"
test_glob "*.{ts,tsx}"     "src/app.ts"  "true"
test_glob "*.{ts,tsx}"     "src/app.tsx" "true"
test_glob "*.{ts,tsx}"     "src/app.js"  "false"
test_glob "*.{js,mjs,cjs}" "util.mjs"   "true"
test_glob "*.{js,mjs,cjs}" "util.cjs"   "true"
test_glob "*.json"         "config.json" "true"
test_glob "*.json"         "config.yaml" "false"

# ── 3. Path-Keyed Resolution ──────────────────────────────────────────────────

echo ""
echo "=== 3. Path-Keyed Resolution ==="

test_path_key() {
  local config_json="$1" file="$2" config_dir="$3" expected_key="$4"
  local result
  result=$(node --input-type=module << EOF 2>&1 || echo "ERROR"
import { resolvePathKeyedSection } from '${PROJECT_ROOT}/src/resolve.ts'
const config = ${config_json}
const section = resolvePathKeyedSection(config, '${file}', '${config_dir}')
if (section === false) console.log('false')
else if (section === null) console.log('null')
else console.log(JSON.stringify(Object.keys(section)))
EOF
)
  if [[ "$result" == *"${expected_key}"* ]]; then
    pass "path-key '${file}' → contains ${expected_key}"
  else
    fail "path-key '${file}': expected ${expected_key}, got ${result}"
  fi
}

CONFIG='{".":{onEdit:{"*.py":"root"}},"packages/api/":{onEdit:{"*.py":"api"}},"packages/legacy/":false}'
test_path_key "$CONFIG" "/repo/src/main.py"              "/repo" "onEdit"
test_path_key "$CONFIG" "/repo/packages/api/handler.py"  "/repo" "onEdit"
test_path_key "$CONFIG" "/repo/packages/legacy/old.py"   "/repo" "false"

# ── 4. Variable Substitution ──────────────────────────────────────────────────

echo ""
echo "=== 4. Variable Substitution ==="

test_subst() {
  local cmd="$1" mode="$2" check="$3"
  local result
  result=$(node --input-type=module << EOF 2>&1 || echo "ERROR"
import { substituteVars } from '${PROJECT_ROOT}/src/substitute.ts'
const r = substituteVars('${cmd}', {
  file: '/tmp/test.py',
  files: ['/tmp/a.py', '/tmp/b.py'],
  projectRoot: '/project',
  configDir: '/project',
  mode: '${mode}'
})
console.log(r)
EOF
)
  if [[ "$result" == *"${check}"* ]]; then
    pass "subst '${cmd}' (${mode}) → contains '${check}'"
  else
    fail "subst '${cmd}' (${mode}): expected '${check}', got '${result}'"
  fi
}

test_subst "echo {file}"       "onEdit" "/tmp/test.py"
test_subst "echo {files}"      "onStop" "/tmp/a.py"
test_subst "echo {files}"      "onStop" "/tmp/b.py"
test_subst "echo"              "onEdit" "echo"
test_subst "echo"              "onStop" "echo"
test_subst "echo {projectRoot}" "onEdit" "/project"
test_subst "./scripts/check.sh" "onEdit" "/project/scripts/check.sh"

# ── 5. Config Discovery ───────────────────────────────────────────────────────

echo ""
echo "=== 5. Config Discovery ==="

test_discovery() {
  local fixture="$1" file_rel="$2" expected="$3"
  local fixture_dir="${SCRIPT_DIR}/${fixture}"
  local result
  result=$(node --input-type=module << EOF 2>&1 || echo "ERROR"
import { findProjectConfig } from '${PROJECT_ROOT}/src/discover.ts'
const found = findProjectConfig('${fixture_dir}/${file_rel}', '${fixture_dir}')
console.log(found ? 'found' : 'not-found')
EOF
)
  if [[ "$result" == "$expected" ]]; then
    pass "discovery: ${fixture}/${file_rel} → ${expected}"
  else
    fail "discovery: ${fixture}/${file_rel}: expected ${expected}, got ${result}"
  fi
}

test_discovery "flat-config"        "src/app.py"          "found"
test_discovery "path-keyed"         "src/main.py"         "found"
test_discovery "path-keyed"         "packages/api/handler.py" "found"
test_discovery "glob-patterns"      "app.py"              "found"
test_discovery "variables"          "src/main.py"         "found"

# ── 6. Type Guards ────────────────────────────────────────────────────────────

echo ""
echo "=== 6. Type Guards ==="

test_type_guard() {
  local config="$1" expected="$2" desc="$3"
  local result
  result=$(node --input-type=module << EOF 2>&1 || echo "ERROR"
import { isPathKeyedConfig } from '${PROJECT_ROOT}/src/types.ts'
const config = ${config}
console.log(isPathKeyedConfig(config))
EOF
)
  if [[ "$result" == "$expected" ]]; then
    pass "isPathKeyedConfig: ${desc} → ${expected}"
  else
    fail "isPathKeyedConfig: ${desc} — expected ${expected}, got ${result}"
  fi
}

test_type_guard '{"onEdit":{"*.py":"cmd"}}'      "false" "flat config"
test_type_guard '{".":{"onEdit":{}}}'            "true"  "has dot key"
test_type_guard '{"packages/api/":{}}'           "true"  "has path key"
test_type_guard '{"onEdit":{},"onStop":{}}'      "false" "both hooks, no paths"

# ── 7. Normalize Command ──────────────────────────────────────────────────────

echo ""
echo "=== 7. Normalize Command ==="

test_normalize() {
  local value="$1" expected="$2"
  local result
  result=$(node --input-type=module << EOF 2>&1 || echo "ERROR"
import { normalizeCommand } from '${PROJECT_ROOT}/src/glob.ts'
const v = ${value}
const r = normalizeCommand(v)
console.log(JSON.stringify(r))
EOF
)
  if [[ "$result" == "$expected" ]]; then
    pass "normalizeCommand(${value}) → ${expected}"
  else
    fail "normalizeCommand(${value}): expected ${expected}, got ${result}"
  fi
}

test_normalize '"cmd"'     '["cmd"]'
test_normalize '["a","b"]' '["a","b"]'
test_normalize 'false'     'null'
test_normalize '""'        'null'
test_normalize '[]'        'null'

# ── Results ───────────────────────────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════════════"
printf 'Results: \033[32m%d passed\033[0m, ' "$PASS"
if [[ $FAIL -eq 0 ]]; then
  printf '\033[32m%d failed\033[0m\n' "$FAIL"
else
  printf '\033[31m%d failed\033[0m\n' "$FAIL"
fi
[[ $FAIL -eq 0 ]]
