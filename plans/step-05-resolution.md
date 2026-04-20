# Step 05: Path-Keyed Resolution and Section Merging

## Context

Path-keyed configs allow different settings for subdirectories (e.g., `"legacy/": false` to disable checks). This step implements path-key resolution (longest prefix match) and section-level merging between global and project configs.

**Overall objective:** Redesign format-check into pi-edit-hooks with onEdit/onStop hooks, path-keyed configs, and workspace grouping.

**This step:** Resolve which config section applies to a file and merge global + project configs.

## Prerequisites

- Step 01 (types.ts) — for config types
- Step 04 (discover.ts) — for `discoverConfigs`, `FoundConfig`

## Files to Read

- `/tmp/plan-architecture.md` — sections 3 (Path-Keyed Resolution) and 4 (Merge Semantics)
- `/tmp/plan-matching.md` — section 2 (Path-Keyed Config Resolution)

## Implementation Tasks

### 1. Create `resolve.ts`

```typescript
// /home/ignacio/pr/pi-edit-hooks/resolve.ts
```

### 2. Import dependencies

```typescript
import { relative, resolve } from 'node:path'
import type {
  FlatConfig,
  GlobCommands,
  PathKeyedConfig,
  RawConfig,
  ResolvedConfig,
  FoundConfig,
} from './types.ts'
import { isPathKeyedConfig } from './types.ts'
import { discoverConfigs } from './discover.ts'
```

### 3. Implement path-keyed section resolution

```typescript
/**
 * Find which section of a path-keyed config applies to a file.
 * Uses longest-prefix match.
 *
 * @param config The path-keyed config
 * @param filePath Absolute path of the edited file
 * @param configDir Directory containing .pi/ (parent of .pi/)
 * @returns The matching section, false (disabled), or null (no match)
 */
export function resolvePathKeyedSection(
  config: PathKeyedConfig,
  filePath: string,
  configDir: string,
): FlatConfig | false | null {
  const absFile = resolve(filePath)
  const absConfigDir = resolve(configDir)
  
  // Compute relative path from config directory to file
  const relPath = relative(absConfigDir, absFile)
  
  // Reject files outside configDir (defensive)
  if (relPath.startsWith('..')) {
    return null
  }
  
  // Collect all matching path keys with their lengths
  const matches: Array<{ key: string; length: number; section: FlatConfig | false }> = []
  
  for (const [key, section] of Object.entries(config)) {
    if (key === '.') {
      // Root default — always matches with length 0
      matches.push({ key, length: 0, section })
    } else {
      // Normalize key: remove trailing slash for comparison
      const normalizedKey = key.replace(/\/$/, '')
      
      // Check if file is within this path prefix
      if (relPath === normalizedKey || relPath.startsWith(normalizedKey + '/')) {
        matches.push({ key, length: normalizedKey.length, section })
      }
    }
  }
  
  if (matches.length === 0) {
    return null
  }
  
  // Longest prefix wins
  matches.sort((a, b) => b.length - a.length)
  return matches[0].section
}
```

### 4. Implement section merging

```typescript
/**
 * Merge global and project configs at section level.
 * Project sections replace global sections entirely (no deep merge).
 *
 * @param global Global config (flat format only)
 * @param project Project config after path-key resolution (flat format)
 */
export function mergeConfigs(
  global: FlatConfig | null,
  project: FlatConfig | null,
): { onEdit: GlobCommands | null; onStop: GlobCommands | null } {
  let onEdit: GlobCommands | null = null
  let onStop: GlobCommands | null = null
  
  // Layer 1: global provides base
  if (global) {
    if (global.onEdit && global.onEdit !== false) {
      onEdit = global.onEdit
    }
    if (global.onStop && global.onStop !== false) {
      onStop = global.onStop
    }
  }
  
  // Layer 2: project overrides entire section
  if (project) {
    // If project defines onEdit (even as false), it replaces global's onEdit
    if ('onEdit' in project) {
      onEdit = project.onEdit === false ? null : (project.onEdit ?? null)
    }
    // Same for onStop
    if ('onStop' in project) {
      onStop = project.onStop === false ? null : (project.onStop ?? null)
    }
  }
  
  return { onEdit, onStop }
}
```

### 5. Implement main resolution function

```typescript
/**
 * Resolve the final config for a specific file.
 * Handles path-keyed resolution and global/project merging.
 *
 * @param filePath Path of the edited file
 * @param boundary Git root or cwd (stops config walk-up)
 * @returns Resolved config, or null if no config found
 */
export function resolveConfig(
  filePath: string,
  boundary: string,
): ResolvedConfig | null {
  const { project, global } = discoverConfigs(filePath, boundary)
  
  // No config at all — nothing runs
  if (!project && !global) {
    return null
  }
  
  let projectSection: FlatConfig | null = null
  let projectRoot: string
  
  if (project) {
    projectRoot = project.configDir
    
    if (isPathKeyedConfig(project.config)) {
      const section = resolvePathKeyedSection(
        project.config,
        filePath,
        project.configDir
      )
      
      if (section === false) {
        // Subtree explicitly disabled — ignore global too
        return { onEdit: null, onStop: null, projectRoot }
      }
      
      projectSection = section
    } else {
      projectSection = project.config as FlatConfig
    }
  } else {
    // No project config — use global config dir as projectRoot
    projectRoot = global!.configDir
  }
  
  // Get global section (must be flat, path-keyed global doesn't make sense)
  const globalSection = global && !isPathKeyedConfig(global.config)
    ? (global.config as FlatConfig)
    : null
  
  // Merge
  const merged = mergeConfigs(globalSection, projectSection)
  
  return {
    onEdit: merged.onEdit,
    onStop: merged.onStop,
    projectRoot,
  }
}
```

## Acceptance Criteria

```bash
cd /home/ignacio/pr/pi-edit-hooks

# 1. File exists
test -f resolve.ts

# 2. TypeScript syntax valid
npx tsc --noEmit resolve.ts discover.ts types.ts 2>&1 | grep -v "Cannot find module" || true

# 3. Required exports
grep -q "export function resolvePathKeyedSection" resolve.ts
grep -q "export function mergeConfigs" resolve.ts
grep -q "export function resolveConfig" resolve.ts

# 4. Uses isPathKeyedConfig type guard
grep -q "isPathKeyedConfig" resolve.ts

# 5. Smoke test for path-keyed resolution
node --input-type=module -e "
import { resolvePathKeyedSection, mergeConfigs } from './resolve.ts'

// Path-keyed resolution test
const config = {
  '.': { onEdit: { '*.py': 'root-edit' } },
  'legacy/': false,
  'packages/api/': { onEdit: { '*.py': 'api-edit' } },
}

// File in root → matches '.'
const root = resolvePathKeyedSection(config, '/repo/app.py', '/repo')
console.assert(root !== null && root !== false, 'root file matches')
console.assert(root.onEdit?.['*.py'] === 'root-edit', 'root section')

// File in legacy → false (disabled)
const legacy = resolvePathKeyedSection(config, '/repo/legacy/old.py', '/repo')
console.assert(legacy === false, 'legacy disabled')

// File in packages/api → matches that section
const api = resolvePathKeyedSection(config, '/repo/packages/api/handler.py', '/repo')
console.assert(api !== null && api !== false, 'api file matches')
console.assert(api.onEdit?.['*.py'] === 'api-edit', 'api section')

// Nested file in packages/api/lib → still matches packages/api/
const apiNested = resolvePathKeyedSection(config, '/repo/packages/api/lib/util.py', '/repo')
console.assert(apiNested !== null && apiNested !== false, 'nested api matches')
console.assert(apiNested.onEdit?.['*.py'] === 'api-edit', 'api section for nested')

console.log('Path-keyed resolution tests passed')
"

# 6. Smoke test for merge semantics
node --input-type=module -e "
import { mergeConfigs } from './resolve.ts'

// Project adds to global
const m1 = mergeConfigs(
  { onEdit: { '*.py': 'global-edit' } },
  { onStop: { '*.py': 'project-stop' } }
)
console.assert(m1.onEdit?.['*.py'] === 'global-edit', 'global onEdit kept')
console.assert(m1.onStop?.['*.py'] === 'project-stop', 'project onStop added')

// Project replaces section
const m2 = mergeConfigs(
  { onEdit: { '*.py': 'global-edit' } },
  { onEdit: { '*.py': 'project-edit' } }
)
console.assert(m2.onEdit?.['*.py'] === 'project-edit', 'project replaces onEdit')

// Project disables section
const m3 = mergeConfigs(
  { onEdit: { '*.py': 'global-edit' }, onStop: { '*.py': 'global-stop' } },
  { onEdit: false }
)
console.assert(m3.onEdit === null, 'onEdit disabled')
console.assert(m3.onStop?.['*.py'] === 'global-stop', 'onStop from global')

console.log('Merge semantics tests passed')
"
```

## Reviewer Instructions

1. Verify longest-prefix matching logic is correct (sort by length descending)
2. Confirm `"."` is treated as root default with length 0
3. Check that path-keyed `false` returns early with disabled config (ignores global)
4. Verify section replacement semantics: project section replaces, doesn't merge
5. Ensure `projectRoot` is set correctly in all code paths
