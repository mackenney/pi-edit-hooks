# Step 03: Variable Substitution

## Context

Commands in config can contain variables like `{file}`, `{files}`, and `{projectRoot}`. This step implements substitution with the new auto-append behavior: if neither `{file}` nor `{files}` is present, the appropriate variable is added based on hook mode.

**Overall objective:** Redesign format-check into pi-edit-hooks with onEdit/onStop hooks, path-keyed configs, and workspace grouping.

**This step:** Create an isolated substitution module with mode-aware auto-append.

## Prerequisites

- Step 01 (types.ts) — for `HookMode` type

## Files to Read

- `/home/ignacio/pr/pi-edit-hooks/core.ts` — current `substituteVars` function
- `/tmp/plan-matching.md` — section 4 (Variable Substitution) for auto-append logic
- `/tmp/plan-architecture.md` — section 6 (Variable Substitution) for specifications

## Implementation Tasks

### 1. Create `substitute.ts`

```typescript
// /home/ignacio/pr/pi-edit-hooks/substitute.ts
```

### 2. Define substitution options interface

```typescript
import { join, resolve } from 'node:path'
import type { HookMode } from './types.ts'

export interface SubstituteOptions {
  file: string           // single file being processed (always present)
  files?: string[]       // all files in group (onStop only)
  projectRoot: string    // directory containing the config file
  configDir: string      // same as projectRoot (for relative path resolution)
  mode: HookMode         // 'onEdit' | 'onStop'
}
```

### 3. Implement shell quoting helper

```typescript
/**
 * Quote a path for shell usage.
 * Uses double quotes to handle spaces and most special chars.
 */
function shellQuote(path: string): string {
  // Escape double quotes and backslashes inside the string
  const escaped = path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `"${escaped}"`
}
```

### 4. Implement `substituteVars`

```typescript
/**
 * Substitute template variables in a command string.
 *
 * Variables:
 *   {file}        — absolute path of the single file
 *   {files}       — space-separated absolute paths (onStop only; degrades to {file} in onEdit)
 *   {projectRoot} — directory containing the config file
 *
 * Auto-append: If command contains neither {file} nor {files}, appends:
 *   - {file} for onEdit mode
 *   - {files} for onStop mode
 *
 * Relative commands (./script.sh, ../bin/check) resolve against configDir.
 */
export function substituteVars(cmd: string, opts: SubstituteOptions): string {
  const absFile = resolve(opts.file)
  let result = cmd

  // Resolve relative command paths against configDir
  if (result.startsWith('./') || result.startsWith('../')) {
    result = join(opts.configDir, result)
  }

  // Auto-append if neither file placeholder present
  const hasFilePlaceholder = result.includes('{file}') || result.includes('{files}')
  if (!hasFilePlaceholder) {
    result = opts.mode === 'onEdit'
      ? `${result} {file}`
      : `${result} {files}`
  }

  // Substitute {file}
  result = result.replace(/\{file\}/g, shellQuote(absFile))

  // Substitute {projectRoot}
  result = result.replace(/\{projectRoot\}/g, shellQuote(opts.projectRoot))

  // Substitute {files}
  if (opts.mode === 'onStop' && opts.files && opts.files.length > 0) {
    const filesArg = opts.files.map(f => shellQuote(resolve(f))).join(' ')
    result = result.replace(/\{files\}/g, filesArg)
  } else {
    // In onEdit mode (or no files provided), {files} degrades to {file}
    result = result.replace(/\{files\}/g, shellQuote(absFile))
  }

  return result
}
```

## Acceptance Criteria

```bash
cd /home/ignacio/pr/pi-edit-hooks

# 1. File exists
test -f substitute.ts

# 2. TypeScript syntax valid
npx tsc --noEmit substitute.ts types.ts 2>&1 | grep -v "Cannot find module" || true

# 3. Required exports
grep -q "export interface SubstituteOptions" substitute.ts
grep -q "export function substituteVars" substitute.ts

# 4. Auto-append logic present
grep -q "hasFilePlaceholder" substitute.ts
grep -q "{files}" substitute.ts

# 5. Smoke test
node --input-type=module -e "
import { substituteVars } from './substitute.ts'

// Basic {file} substitution
const r1 = substituteVars('echo {file}', {
  file: '/tmp/test.py',
  projectRoot: '/project',
  configDir: '/project',
  mode: 'onEdit'
})
console.assert(r1.includes('/tmp/test.py'), 'file substituted')

// Auto-append {file} in onEdit
const r2 = substituteVars('ruff check', {
  file: '/tmp/test.py',
  projectRoot: '/project',
  configDir: '/project',
  mode: 'onEdit'
})
console.assert(r2.includes('{file}') === false, 'no literal {file} left')
console.assert(r2.includes('/tmp/test.py'), 'file auto-appended')
console.assert(r2.startsWith('ruff check'), 'command preserved')

// Auto-append {files} in onStop
const r3 = substituteVars('ruff check', {
  file: '/tmp/a.py',
  files: ['/tmp/a.py', '/tmp/b.py'],
  projectRoot: '/project',
  configDir: '/project',
  mode: 'onStop'
})
console.assert(r3.includes('/tmp/a.py'), 'first file present')
console.assert(r3.includes('/tmp/b.py'), 'second file present')

// {files} in onEdit degrades to {file}
const r4 = substituteVars('echo {files}', {
  file: '/tmp/test.py',
  projectRoot: '/project',
  configDir: '/project',
  mode: 'onEdit'
})
console.assert(r4.includes('/tmp/test.py'), 'files degrades to file in onEdit')

// {projectRoot} substitution
const r5 = substituteVars('./scripts/check.sh', {
  file: '/tmp/test.py',
  projectRoot: '/project',
  configDir: '/project',
  mode: 'onEdit'
})
console.assert(r5.includes('/project/scripts/check.sh'), 'relative path resolved')

// No double-append when {file} already present
const r6 = substituteVars('mypy {file}', {
  file: '/tmp/test.py',
  projectRoot: '/project',
  configDir: '/project',
  mode: 'onEdit'
})
const count = (r6.match(/test\.py/g) || []).length
console.assert(count === 1, 'file appears exactly once')

console.log('All substitute tests passed')
"
```

## Reviewer Instructions

1. Verify auto-append adds `{file}` for onEdit, `{files}` for onStop
2. Confirm `{files}` degrades to `{file}` in onEdit mode (not an error)
3. Check relative path resolution uses `join()` not string concatenation
4. Ensure shell quoting handles spaces and special characters
5. Verify `{projectRoot}` substitution works
