# Step 09: Test Fixtures and Verification

## Context

Test fixtures provide controlled environments for verifying the extension behavior. The `verify.sh` script validates config files, tests glob matching, path-keyed resolution, and variable substitution using Node directly (no additional dependencies).

**Overall objective:** Redesign format-check into pi-edit-hooks with onEdit/onStop hooks, path-keyed configs, and workspace grouping.

**This step:** Create test fixtures and a comprehensive verification script.

## Prerequisites

- All previous steps completed (full codebase available)

## Files to Read

- `/home/ignacio/pr/agent-tools/test-repos/` — reference fixture structure
- `/tmp/plan-matching.md` — section 5 (Test Fixtures) for fixture designs

## Implementation Tasks

### 1. Create test-repos directory structure

```
test-repos/
├── README.md
├── verify.sh
├── flat-config/
│   ├── .pi/
│   │   └── edit-hooks.json
│   ├── src/
│   │   └── app.py
│   └── pyproject.toml
├── path-keyed/
│   ├── .pi/
│   │   └── edit-hooks.json
│   ├── packages/
│   │   ├── api/
│   │   │   └── handler.py
│   │   └── legacy/
│   │       └── old.py
│   ├── src/
│   │   └── main.py
│   └── pyproject.toml
├── glob-patterns/
│   ├── .pi/
│   │   └── edit-hooks.json
│   ├── app.py
│   ├── app.ts
│   ├── app.tsx
│   ├── app.mjs
│   └── config.json
├── workspace-grouping/
│   ├── .pi/
│   │   └── edit-hooks.json
│   ├── packages/
│   │   ├── api/
│   │   │   ├── pyproject.toml
│   │   │   └── handler.py
│   │   └── web/
│   │       ├── package.json
│   │       └── app.ts
│   └── pyproject.toml
├── variables/
│   ├── .pi/
│   │   └── edit-hooks.json
│   ├── scripts/
│   │   └── check.sh
│   └── src/
│       └── main.py
└── disabled/
    ├── .pi/
    │   └── edit-hooks.json
    └── src/
        └── app.py
```

### 2. Create fixture configs

#### `flat-config/.pi/edit-hooks.json`
```json
{
  "onEdit": { "*.py": "echo edit {file}" },
  "onStop": { "*.py": "echo stop {files}" }
}
```

#### `path-keyed/.pi/edit-hooks.json`
```json
{
  ".": { 
    "onEdit": { "*.py": "echo root-edit" }, 
    "onStop": { "*.py": "echo root-stop" } 
  },
  "packages/api/": { 
    "onEdit": { "*.py": "echo api-edit" } 
  },
  "packages/legacy/": false
}
```

#### `glob-patterns/.pi/edit-hooks.json`
```json
{
  "onEdit": {
    "*.py": "echo python",
    "*.{ts,tsx}": "echo typescript",
    "*.{js,mjs,cjs}": "echo javascript",
    "*.json": "echo json"
  }
}
```

#### `workspace-grouping/.pi/edit-hooks.json`
```json
{
  "onStop": {
    "*.py": "echo py-files {files}",
    "*.ts": "echo ts-files {files}"
  }
}
```

#### `variables/.pi/edit-hooks.json`
```json
{
  "onEdit": { "*.py": "./scripts/check.sh" },
  "onStop": { "*.py": "echo {projectRoot}" }
}
```

#### `disabled/.pi/edit-hooks.json`
```json
{
  "onEdit": false,
  "onStop": false
}
```

### 3. Create verify.sh

```bash
#!/usr/bin/env bash
# verify.sh — validate test fixtures and core logic for pi-edit-hooks
# Dependencies: node, jq (no python, uv, npm required)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

PASS=0; FAIL=0
pass() { printf '\033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
fail() { printf '\033[31m✗\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }

# ─── 1. Config JSON Validation ──────────────────────────────────────────────

echo "=== 1. Config JSON Validation ==="

while IFS= read -r -d '' f; do
  rel="${f#"$SCRIPT_DIR/"}"
  if jq . "$f" >/dev/null 2>&1; then
    pass "$rel — valid JSON"
  else
    fail "$rel — invalid JSON"
  fi
done < <(find "$SCRIPT_DIR" -name 'edit-hooks.json' -path '*/.pi/*' -print0)

# ─── 2. Glob Matching ───────────────────────────────────────────────────────

echo ""
echo "=== 2. Glob Matching ==="

test_glob() {
  local pattern="$1" file="$2" expected="$3"
  local result
  result=$(node --input-type=module << EOF
import { matchesGlob } from '${PROJECT_ROOT}/glob.ts'
console.log(matchesGlob('$file', '$pattern'))
EOF
)
  if [[ "$result" == "$expected" ]]; then
    pass "glob '$pattern' vs '$file' → $expected"
  else
    fail "glob '$pattern' vs '$file': expected $expected, got $result"
  fi
}

test_glob "*.py" "src/app.py" "true"
test_glob "*.py" "src/app.ts" "false"
test_glob "*.{ts,tsx}" "src/app.ts" "true"
test_glob "*.{ts,tsx}" "src/app.tsx" "true"
test_glob "*.{ts,tsx}" "src/app.js" "false"
test_glob "*.{js,mjs,cjs}" "util.mjs" "true"
test_glob "*.{js,mjs,cjs}" "util.cjs" "true"
test_glob "*.json" "config.json" "true"
test_glob "*.json" "config.yaml" "false"

# ─── 3. Path-Keyed Resolution ───────────────────────────────────────────────

echo ""
echo "=== 3. Path-Keyed Resolution ==="

test_path_key() {
  local config_json="$1" file="$2" config_dir="$3" expected_key="$4"
  local result
  result=$(node --input-type=module << EOF
import { resolvePathKeyedSection } from '${PROJECT_ROOT}/resolve.ts'
const config = $config_json
const section = resolvePathKeyedSection(config, '$file', '$config_dir')
if (section === false) console.log('false')
else if (section === null) console.log('null')
else console.log(JSON.stringify(Object.keys(section)))
EOF
)
  if [[ "$result" == *"$expected_key"* ]]; then
    pass "path-key '$file' → contains $expected_key"
  else
    fail "path-key '$file': expected $expected_key, got $result"
  fi
}

CONFIG='{".":{onEdit:{"*.py":"root"}},"packages/api/":{onEdit:{"*.py":"api"}},"packages/legacy/":false}'
test_path_key "$CONFIG" "/repo/src/main.py" "/repo" "onEdit"
test_path_key "$CONFIG" "/repo/packages/api/handler.py" "/repo" "onEdit"
test_path_key "$CONFIG" "/repo/packages/legacy/old.py" "/repo" "false"

# ─── 4. Variable Substitution ───────────────────────────────────────────────

echo ""
echo "=== 4. Variable Substitution ==="

test_subst() {
  local cmd="$1" mode="$2" check="$3"
  local result
  result=$(node --input-type=module << EOF
import { substituteVars } from '${PROJECT_ROOT}/substitute.ts'
const r = substituteVars('$cmd', {
  file: '/tmp/test.py',
  files: ['/tmp/a.py', '/tmp/b.py'],
  projectRoot: '/project',
  configDir: '/project',
  mode: '$mode'
})
console.log(r)
EOF
)
  if [[ "$result" == *"$check"* ]]; then
    pass "subst '$cmd' ($mode) → contains '$check'"
  else
    fail "subst '$cmd' ($mode): expected '$check', got '$result'"
  fi
}

test_subst "echo {file}" "onEdit" "/tmp/test.py"
test_subst "echo" "onEdit" "/tmp/test.py"        # auto-append {file}
test_subst "echo" "onStop" "/tmp/a.py"           # auto-append {files}
test_subst "echo" "onStop" "/tmp/b.py"           # auto-append {files}
test_subst "echo {projectRoot}" "onEdit" "/project"
test_subst "./scripts/check.sh" "onEdit" "/project/scripts/check.sh"  # relative path resolution

# ─── 5. Config Discovery ────────────────────────────────────────────────────

echo ""
echo "=== 5. Config Discovery ==="

# Test that flat-config fixture is found
FLAT_DIR="$SCRIPT_DIR/flat-config"
result=$(node --input-type=module << EOF
import { findProjectConfig } from '${PROJECT_ROOT}/discover.ts'
const found = findProjectConfig('${FLAT_DIR}/src/app.py', '${FLAT_DIR}')
console.log(found ? 'found' : 'not-found')
EOF
)
if [[ "$result" == "found" ]]; then
  pass "discovery: flat-config found"
else
  fail "discovery: flat-config not found"
fi

# ─── 6. Type Guard ──────────────────────────────────────────────────────────

echo ""
echo "=== 6. Type Guards ==="

test_type_guard() {
  local config="$1" expected="$2" desc="$3"
  local result
  result=$(node --input-type=module << EOF
import { isPathKeyedConfig } from '${PROJECT_ROOT}/types.ts'
const config = $config
console.log(isPathKeyedConfig(config))
EOF
)
  if [[ "$result" == "$expected" ]]; then
    pass "isPathKeyedConfig: $desc → $expected"
  else
    fail "isPathKeyedConfig: $desc — expected $expected, got $result"
  fi
}

test_type_guard '{"onEdit":{"*.py":"cmd"}}' "false" "flat config"
test_type_guard '{".":{"onEdit":{}}}' "true" "has dot key"
test_type_guard '{"packages/api/":{}}' "true" "has path key"
test_type_guard '{"onEdit":{},"onStop":{}}' "false" "both hooks, no paths"

# ─── 7. Normalize Command ───────────────────────────────────────────────────

echo ""
echo "=== 7. Normalize Command ==="

test_normalize() {
  local value="$1" expected="$2"
  local result
  result=$(node --input-type=module << EOF
import { normalizeCommand } from '${PROJECT_ROOT}/glob.ts'
const v = $value
const r = normalizeCommand(v)
console.log(JSON.stringify(r))
EOF
)
  if [[ "$result" == "$expected" ]]; then
    pass "normalizeCommand($value) → $expected"
  else
    fail "normalizeCommand($value): expected $expected, got $result"
  fi
}

test_normalize '"cmd"' '["cmd"]'
test_normalize '["a","b"]' '["a","b"]'
test_normalize 'false' 'null'
test_normalize '""' 'null'
test_normalize '[]' 'null'

# ─── Results ────────────────────────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════════════"
printf 'Results: \033[32m%d passed\033[0m, ' "$PASS"
if [[ $FAIL -eq 0 ]]; then
  printf '\033[32m%d failed\033[0m\n' "$FAIL"
else
  printf '\033[31m%d failed\033[0m\n' "$FAIL"
fi
exit $([[ $FAIL -eq 0 ]] && echo 0 || echo 1)
```

### 4. Create test-repos/README.md

```markdown
# Test Fixtures

Test fixtures for pi-edit-hooks verification.

## Running Tests

```bash
./verify.sh
```

## Fixtures

| Fixture | Purpose |
|---------|---------|
| `flat-config/` | Basic onEdit + onStop config |
| `path-keyed/` | Subdirectory scoping with `.` and `false` |
| `glob-patterns/` | Brace expansion and pattern matching |
| `workspace-grouping/` | Manifest-based file grouping |
| `variables/` | Variable substitution and relative paths |
| `disabled/` | Completely disabled hooks |

## Manual Testing

To manually test the extension:

1. Create a test project with `.pi/edit-hooks.json`
2. Install the extension in pi
3. Edit a file and observe onEdit output
4. Complete the turn and observe onStop behavior
```

### 5. Create placeholder source files

Each fixture needs minimal source files for testing:

- `flat-config/src/app.py` → `# flat config test`
- `flat-config/pyproject.toml` → `[project]\nname = "flat-test"`
- `path-keyed/src/main.py` → `# path-keyed root`
- `path-keyed/packages/api/handler.py` → `# api handler`
- `path-keyed/packages/legacy/old.py` → `# legacy code`
- `path-keyed/pyproject.toml` → `[project]\nname = "path-keyed-test"`
- etc.

## Acceptance Criteria

```bash
cd /home/ignacio/pr/pi-edit-hooks

# 1. Test directory exists
test -d test-repos

# 2. verify.sh is executable
test -x test-repos/verify.sh

# 3. All fixture directories exist
for d in flat-config path-keyed glob-patterns workspace-grouping variables disabled; do
  test -d "test-repos/$d" || { echo "Missing: $d"; exit 1; }
done

# 4. All config files are valid JSON
find test-repos -name 'edit-hooks.json' -exec node -e "JSON.parse(require('fs').readFileSync('{}'))" \;

# 5. verify.sh passes (requires all previous steps complete)
cd test-repos && ./verify.sh
```

## Reviewer Instructions

1. Run `./verify.sh` and confirm all tests pass
2. Verify each fixture has the correct config structure
3. Check that glob tests cover brace expansion edge cases
4. Confirm path-keyed tests cover `.`, explicit paths, and `false`
5. Ensure variable substitution tests cover auto-append for both modes
6. Verify README.md accurately describes fixtures
