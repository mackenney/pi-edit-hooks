# Step 02: Glob Matching

## Context

The extension matches file paths against glob patterns to determine which commands to run. The current implementation in `core.ts` works but has incomplete regex escaping. This step extracts and improves the glob matching logic.

**Overall objective:** Redesign format-check into pi-edit-hooks with onEdit/onStop hooks, path-keyed configs, and workspace grouping.

**This step:** Create an isolated, well-tested glob matching module that handles brace expansion and proper regex escaping.

## Prerequisites

- Step 01 (types.ts) — for `GlobCommands` and `CommandValue` types

## Files to Read

- `/home/ignacio/pr/pi-edit-hooks/core.ts` — current `expandBraces`, `matchesGlob`, `findCommand`
- `/tmp/plan-matching.md` — section 1 (Glob Matching) for improvements

## Implementation Tasks

### 1. Create `glob.ts`

```typescript
// /home/ignacio/pr/pi-edit-hooks/glob.ts
```

### 2. Implement `expandBraces`

Keep the current implementation — it handles single brace groups which is sufficient:

```typescript
/**
 * Expand a single brace group in a glob pattern.
 * "*.{ts,tsx}" → ["*.ts", "*.tsx"]
 * No nested braces support (not needed for config use cases).
 */
export function expandBraces(pattern: string): string[] {
  const m = pattern.match(/^(.*)\{([^}]+)\}(.*)$/)
  if (!m) return [pattern]
  const [, pre, inner, post] = m
  return inner.split(',').map((part) => `${pre}${part}${post}`)
}
```

### 3. Implement `matchesGlob` with improved escaping

The current implementation only escapes `.`. Fix to escape ALL regex metacharacters:

```typescript
import { basename } from 'node:path'

/**
 * Test if a file matches a glob pattern.
 * Matches against basename only (no path components).
 * Supports * wildcard and brace expansion.
 */
export function matchesGlob(file: string, pattern: string): boolean {
  const name = basename(file)
  for (const expanded of expandBraces(pattern)) {
    // Escape all regex metacharacters EXCEPT *, then convert * to .*
    const escaped = expanded
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
    const regex = new RegExp(`^${escaped}$`)
    if (regex.test(name)) return true
  }
  return false
}
```

**Key change:** `[.+^${}()|[\]\\]` covers all regex special chars. The current code only does `.`.

### 4. Implement `findCommand`

Import types and implement first-match-wins:

```typescript
import type { CommandValue, GlobCommands } from './types.ts'

/**
 * Find the first matching command for a file.
 * Returns null if no glob matches.
 * First match wins — order matters.
 */
export function findCommand(globs: GlobCommands, file: string): CommandValue | null {
  for (const [pattern, cmd] of Object.entries(globs)) {
    if (matchesGlob(file, pattern)) return cmd
  }
  return null
}
```

### 5. Implement `normalizeCommand`

Convert CommandValue to a normalized form for execution:

```typescript
/**
 * Normalize a command value to an array of strings or null (disabled).
 */
export function normalizeCommand(value: CommandValue): string[] | null {
  if (value === false) return null
  if (value === '') return null
  if (Array.isArray(value)) {
    if (value.length === 0) return null
    return value
  }
  return [value]
}
```

## Acceptance Criteria

```bash
cd /home/ignacio/pr/pi-edit-hooks

# 1. File exists
test -f glob.ts

# 2. TypeScript syntax valid (with types.ts present)
npx tsc --noEmit glob.ts types.ts 2>&1 | grep -v "Cannot find module" || true

# 3. Required functions exported
grep -q "export function expandBraces" glob.ts
grep -q "export function matchesGlob" glob.ts
grep -q "export function findCommand" glob.ts
grep -q "export function normalizeCommand" glob.ts

# 4. Improved escaping includes all metacharacters
grep -q '\[.+\^' glob.ts  # Should see character class with multiple metacharacters

# 5. Quick smoke test via node
node --input-type=module -e "
import { matchesGlob, expandBraces, normalizeCommand } from './glob.ts'

// Brace expansion
const exp = expandBraces('*.{ts,tsx}')
console.assert(exp.length === 2, 'brace expansion')
console.assert(exp.includes('*.ts'), 'includes *.ts')
console.assert(exp.includes('*.tsx'), 'includes *.tsx')

// Basic matching
console.assert(matchesGlob('src/app.py', '*.py'), 'match .py')
console.assert(!matchesGlob('src/app.ts', '*.py'), 'no match .ts vs .py')

// Brace match
console.assert(matchesGlob('src/app.ts', '*.{ts,tsx}'), 'brace match ts')
console.assert(matchesGlob('src/app.tsx', '*.{ts,tsx}'), 'brace match tsx')
console.assert(!matchesGlob('src/app.js', '*.{ts,tsx}'), 'brace no match js')

// Edge case: special characters in filename
console.assert(matchesGlob('foo+bar.ts', '*.ts'), 'plus in filename')
console.assert(!matchesGlob('fooXbar.ts', 'foo+bar.ts'), 'plus is literal')

// Normalize
console.assert(normalizeCommand(false) === null, 'false → null')
console.assert(normalizeCommand('cmd')[0] === 'cmd', 'string → array')
console.assert(normalizeCommand(['a','b']).length === 2, 'array preserved')
console.assert(normalizeCommand([]) === null, 'empty array → null')

console.log('All glob tests passed')
"
```

## Reviewer Instructions

1. Verify the regex escaping covers all metacharacters: `. + ^ $ { } ( ) | [ ] \`
2. Confirm `findCommand` returns `CommandValue` (not just string) to support arrays and false
3. Ensure `normalizeCommand` handles edge cases (empty string, empty array)
4. Check that only basename is matched (no path component matching)
