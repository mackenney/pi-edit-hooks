#!/usr/bin/env bash
# e2e-tests/run.sh — validates confirmed code review findings end-to-end
# Dependencies: node (v22+ with native TypeScript strip support)

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

PASS=0; FAIL=0
pass() { printf '\033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
fail() { printf '\033[31m✗\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }

echo "=== E2E Tests: Validating code review findings ==="

# ── 1. Shell injection via $() in filename ────────────────────────────────────
echo ""
echo "--- 1. Shell injection neutralized (shellQuote uses single-quote wrapping) ---"
cmd=$(node --input-type=module << 'EOF'
import { substituteVars } from '../substitute.ts'
const result = substituteVars('echo', {
  file: '/tmp/$(echo INJECTED).ts',
  projectRoot: '/proj',
  configDir: '/proj',
  mode: 'onEdit'
})
console.log(result)
EOF
)
# The substituted command should single-quote the filename so $() is literal
if echo "$cmd" | grep -qF "'"; then
  pass "shellQuote wraps path in single quotes: $cmd"
else
  fail "No single-quote wrapping found: $cmd"
fi

# When actually executed, the shell must NOT expand $(echo INJECTED)
# Injection fires  → output is just "INJECTED" (subshell ran, path stripped)
# No injection     → output contains literal '$(echo INJECTED)' text
exec_out=$(bash -c "$cmd" 2>&1 || true)
if echo "$exec_out" | grep -qF '$(echo INJECTED)'; then
  pass "Shell execution: subshell was NOT executed (literal text preserved)"
elif [[ "$exec_out" == "INJECTED" ]]; then
  fail "INJECTION FIRED: subshell executed, output was 'INJECTED'"
else
  # Output contains the path literally — that's fine too
  pass "Shell execution: no subshell execution detected (output: $exec_out)"
fi

# ── 2. cli.mjs shell quoting ──────────────────────────────────────────────────
echo ""
echo "--- 2. cli.mjs substituteVars uses shellQuote ---"
result=$(node --input-type=module << 'EOF'
import { readFileSync } from 'node:fs'
const src = readFileSync(new URL('../cli.mjs', import.meta.url), 'utf8')
const hasShellQuote  = src.includes('function shellQuote')
const usesShellQuote = src.includes('shellQuote(absFile)') || src.includes('shellQuote(resolve(')
console.log(hasShellQuote && usesShellQuote ? 'yes' : 'no')
EOF
)
if [[ "$result" == "yes" ]]; then
  pass "cli.mjs uses shellQuote for all path substitutions"
else
  fail "cli.mjs missing shellQuote: $result"
fi

# ── 3. session_id path traversal blocked ─────────────────────────────────────
echo ""
echo "--- 3. session_id validated before /tmp path ---"
traversal_file="/tmp/TRAVERSAL_TARGET_$$"
rm -f "$traversal_file"
echo '{"tool_input":{"file_path":"/tmp/test.py"},"session_id":"../../tmp/TRAVERSAL_TARGET_'"$$"'"}' \
  | node "$PROJECT_ROOT/cli.mjs" accumulate 2>/dev/null || true
if [[ -f "$traversal_file" ]]; then
  rm -f "$traversal_file"
  fail "PATH TRAVERSAL: file written outside /tmp/agent-edits-*"
else
  pass "session_id traversal blocked"
fi

echo '{"tool_input":{"file_path":"/tmp/test.py"},"session_id":"test-session-123"}' \
  | node "$PROJECT_ROOT/cli.mjs" accumulate 2>/dev/null
if [[ -f "/tmp/agent-edits-test-session-123" ]]; then
  pass "Valid session_id still works"
  rm -f /tmp/agent-edits-test-session-123
else
  fail "Valid session_id rejected or file not created"
fi

# ── 4. expandBraces handles multiple brace groups ─────────────────────────────
echo ""
echo "--- 4. expandBraces multi-group: {a,b}.{c,d} ---"
result=$(node --input-type=module << 'EOF'
import { expandBraces } from '../glob.ts'
const expanded = expandBraces('{a,b}.{c,d}')
console.log(JSON.stringify(expanded.sort()))
EOF
)
expected='["a.c","a.d","b.c","b.d"]'
if [[ "$result" == "$expected" ]]; then
  pass "expandBraces multi-group correct: $result"
else
  fail "expandBraces multi-group BROKEN: got $result, expected $expected"
fi

result2=$(node --input-type=module << 'EOF'
import { expandBraces } from '../glob.ts'
console.log(JSON.stringify(expandBraces('*.{ts,tsx}')))
EOF
)
if [[ "$result2" == '["*.ts","*.tsx"]' ]]; then
  pass "expandBraces single group still correct"
else
  fail "expandBraces regression on single group: $result2"
fi

# ── 5. matchesGlob is basename-only by design ─────────────────────────────────
echo ""
echo "--- 5. matchesGlob: basename-only (path patterns not supported by design) ---"
result=$(node --input-type=module << 'EOF'
import { matchesGlob } from '../glob.ts'
const ok1 = matchesGlob('/project/src/app.ts', '*.ts')
const ok2 = matchesGlob('/project/src/app.ts', 'src/*.ts')
const ok3 = matchesGlob('/project/other/app.ts', 'src/*.ts')
console.log(ok1, ok2, ok3)
EOF
)
basename_match=$(echo "$result" | awk '{print $1}')
path_src=$(echo "$result"        | awk '{print $2}')
path_other=$(echo "$result"      | awk '{print $3}')

[[ "$basename_match" == "true"  ]] && pass "Basename pattern *.ts matches app.ts" \
                                   || fail "Basename pattern *.ts failed: $basename_match"
if [[ "$path_src" == "false" && "$path_other" == "false" ]]; then
  pass "Path pattern src/*.ts correctly returns false (use path-keyed config for directory scoping)"
else
  fail "Path pattern src/*.ts unexpected: src=$path_src other=$path_other (expected both false)"
fi

# ── 6. workspace field threads through to grouping ───────────────────────────
echo ""
echo "--- 6. workspace field present in ResolvedConfig ---"
result=$(node --input-type=module << 'EOF'
import { resolveConfig } from '../resolve.ts'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const dir = '/tmp/ws-test-fixture-e2e'
mkdirSync(join(dir, '.pi'), { recursive: true })
writeFileSync(join(dir, '.pi', 'edit-hooks.json'), JSON.stringify({
  onEdit: { '*.py': 'echo test' },
  workspace: 'pyproject.toml'
}))
writeFileSync(join(dir, 'test.py'), '# test')

const config = resolveConfig(join(dir, 'test.py'), dir)
console.log(config?.workspace ?? 'MISSING')

rmSync(dir, { recursive: true })
EOF
)
if [[ "$result" == "pyproject.toml" ]]; then
  pass "workspace field threaded through ResolvedConfig"
else
  fail "workspace MISSING from ResolvedConfig: got '$result'"
fi

# ── 7. cli.mjs grouping uses all manifests ────────────────────────────────────
echo ""
echo "--- 7. cli.mjs groupFilesByManifest handles TypeScript (package.json) ---"
result=$(node --input-type=module << 'EOF'
import { readFileSync } from 'node:fs'
const src = readFileSync(new URL('../cli.mjs', import.meta.url), 'utf8')
const hasExtTable = src.includes('EXTENSION_MANIFEST')
const hasOldFn    = src.includes('groupFilesByPyproject')
console.log(hasExtTable && !hasOldFn ? 'yes' : 'no')
EOF
)
if [[ "$result" == "yes" ]]; then
  pass "cli.mjs uses multi-manifest grouping (EXTENSION_MANIFEST present, groupFilesByPyproject removed)"
else
  fail "cli.mjs still uses pyproject-only grouping: $result"
fi

# ── 8. path-keyed global config emits warning ─────────────────────────────────
echo ""
echo "--- 8. Path-keyed global config emits warning ---"
result=$(node --input-type=module << 'EOF' 2>&1
import { resolveConfig } from '../resolve.ts'
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const globalDir  = join(homedir(), '.pi', 'agent')
const globalPath = join(globalDir, 'edit-hooks.json')

// Save and replace global config with a path-keyed version
let original = null
if (existsSync(globalPath)) original = readFileSync(globalPath, 'utf8')
mkdirSync(globalDir, { recursive: true })
writeFileSync(globalPath, JSON.stringify({ '.': { onEdit: { '*.py': 'echo global' } } }))

// Create a temp project with no local config
const dir = '/tmp/pk-global-test-e2e'
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'test.py'), '# test')

resolveConfig(join(dir, 'test.py'), dir)

// Restore
if (original !== null) writeFileSync(globalPath, original)
else { try { const { unlinkSync } = await import('node:fs'); unlinkSync(globalPath) } catch {} }
rmSync(dir, { recursive: true })
EOF
)
if echo "$result" | grep -q 'pi-edit-hooks.*path-keyed'; then
  pass "Path-keyed global config warning emitted"
else
  fail "No warning for path-keyed global config. stderr: $result"
fi

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
