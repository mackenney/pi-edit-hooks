# Step 04: Config Parsing and Discovery

## Context

Config discovery walks up from the edited file to find `.pi/edit-hooks.json`, stopping at a git boundary determined at session start. This step implements parsing, validation, and boundary-aware discovery.

**Overall objective:** Redesign format-check into pi-edit-hooks with onEdit/onStop hooks, path-keyed configs, and workspace grouping.

**This step:** Implement config file loading and boundary-aware discovery algorithm.

## Prerequisites

- Step 01 (types.ts) — for `RawConfig`, `FoundConfig` types

## Files to Read

- `/home/ignacio/pr/pi-edit-hooks/core.ts` — current `findConfig`, `loadConfig`
- `/tmp/plan-architecture.md` — sections 2 (Discovery) and 3 (Path-Keyed Resolution)

## Implementation Tasks

### 1. Create `discover.ts`

```typescript
// /home/ignacio/pr/pi-edit-hooks/discover.ts
```

### 2. Define constants

```typescript
import { exec as execCb } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import type { RawConfig, FoundConfig } from './types.ts'

const exec = promisify(execCb)

/** Config file locations */
export const CONFIG_DIR = '.pi'
export const CONFIG_FILE = 'edit-hooks.json'
export const GLOBAL_CONFIG_PATH = join(homedir(), '.pi', 'agent', CONFIG_FILE)
export const GLOBAL_CONFIG_DIR = join(homedir(), '.pi', 'agent')
```

### 3. Implement git root detection

```typescript
/**
 * Get the git repository root for a directory.
 * Returns null if not in a git repository.
 */
export async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git rev-parse --show-toplevel', { cwd })
    return stdout.trim()
  } catch {
    return null // not a git repo
  }
}
```

### 4. Implement config parsing

```typescript
/**
 * Parse and validate a config file.
 * Returns null if file doesn't exist, is invalid JSON, or fails validation.
 * Logs warnings for invalid configs but does not throw.
 */
export function parseConfigFile(configPath: string): RawConfig | null {
  try {
    const content = readFileSync(configPath, 'utf8')
    const parsed = JSON.parse(content)
    
    // Basic validation: must be an object
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      console.warn(`[pi-edit-hooks] Invalid config at ${configPath}: not an object`)
      return null
    }
    
    return parsed as RawConfig
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[pi-edit-hooks] Failed to parse ${configPath}: ${err}`)
    }
    return null
  }
}
```

### 5. Implement project config discovery

```typescript
/**
 * Find project config by walking up from filePath.
 * Stops at the boundary directory (git root or cwd fallback).
 * Returns null if no config found.
 */
export function findProjectConfig(filePath: string, boundary: string): FoundConfig | null {
  let dir = dirname(resolve(filePath))
  const boundaryAbs = resolve(boundary)
  
  while (true) {
    const candidate = join(dir, CONFIG_DIR, CONFIG_FILE)
    if (existsSync(candidate)) {
      const config = parseConfigFile(candidate)
      if (config !== null) {
        return { config, configDir: dir }
      }
      // Invalid config — continue searching up
    }
    
    // Stop at boundary
    if (dir === boundaryAbs) {
      return null
    }
    
    // Stop at filesystem root
    const parent = dirname(dir)
    if (parent === dir) {
      return null
    }
    
    dir = parent
  }
}
```

### 6. Implement global config loading

```typescript
/**
 * Load the global config from ~/.pi/agent/edit-hooks.json.
 * Returns null if file doesn't exist or is invalid.
 */
export function loadGlobalConfig(): FoundConfig | null {
  if (!existsSync(GLOBAL_CONFIG_PATH)) {
    return null
  }
  
  const config = parseConfigFile(GLOBAL_CONFIG_PATH)
  if (config === null) {
    return null
  }
  
  return { config, configDir: GLOBAL_CONFIG_DIR }
}
```

### 7. Implement combined discovery

```typescript
/**
 * Find config for a file, checking project then global.
 * Project config takes precedence over global.
 * Returns both configs when available (for merge step).
 */
export function discoverConfigs(
  filePath: string,
  boundary: string,
): { project: FoundConfig | null; global: FoundConfig | null } {
  const project = findProjectConfig(filePath, boundary)
  const global = loadGlobalConfig()
  return { project, global }
}
```

## Acceptance Criteria

```bash
cd /home/ignacio/pr/pi-edit-hooks

# 1. File exists
test -f discover.ts

# 2. TypeScript syntax valid
npx tsc --noEmit discover.ts types.ts 2>&1 | grep -v "Cannot find module" || true

# 3. Required exports
grep -q "export const CONFIG_DIR" discover.ts
grep -q "export const CONFIG_FILE" discover.ts
grep -q "export async function getGitRoot" discover.ts
grep -q "export function parseConfigFile" discover.ts
grep -q "export function findProjectConfig" discover.ts
grep -q "export function loadGlobalConfig" discover.ts
grep -q "export function discoverConfigs" discover.ts

# 4. Uses correct config path
grep -q "edit-hooks.json" discover.ts
grep -q '\.pi' discover.ts

# 5. Smoke test for git root detection
node --input-type=module -e "
import { getGitRoot, parseConfigFile } from './discover.ts'

// Git root detection (this repo should be a git repo)
const root = await getGitRoot(process.cwd())
console.assert(root !== null, 'should find git root')
console.assert(root.includes('pi-edit-hooks'), 'should be this repo')

// Parse invalid JSON
const invalid = parseConfigFile('/nonexistent/file.json')
console.assert(invalid === null, 'nonexistent returns null')

console.log('All discovery tests passed')
"

# 6. Verify boundary-aware discovery doesn't go past boundary
node --input-type=module -e "
import { findProjectConfig } from './discover.ts'
import { resolve, dirname } from 'node:path'

// With boundary at cwd, should not find config in parent
const cwd = process.cwd()
const result = findProjectConfig(cwd + '/types.ts', cwd)
// Result depends on whether .pi/edit-hooks.json exists
console.log('findProjectConfig result:', result ? 'found' : 'not found')
console.log('Discovery boundary test completed')
"
```

## Reviewer Instructions

1. Verify `CONFIG_FILE` is `edit-hooks.json` (not `tools.json`)
2. Verify `CONFIG_DIR` is `.pi` (not `.agent`)
3. Confirm boundary parameter stops walk-up correctly
4. Check that invalid JSON logs warning but doesn't throw
5. Ensure global path is `~/.pi/agent/edit-hooks.json`
