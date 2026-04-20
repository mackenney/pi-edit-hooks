# Step 01: TypeScript Interfaces

## Context

The pi-edit-hooks redesign replaces the old four-tier config (syntax/format/lint/typecheck) with two hooks: `onEdit` and `onStop`. This step defines all TypeScript interfaces that subsequent steps depend on.

**Overall objective:** Redesign format-check into pi-edit-hooks with onEdit/onStop hooks, path-keyed configs, and workspace grouping.

**This step:** Establish the type foundation so other steps can import and use consistent types.

## Prerequisites

None — this is a foundation step.

## Files to Read

- `/home/ignacio/pr/pi-edit-hooks/core.ts` — current ToolsConfig for reference
- `/tmp/plan-architecture.md` — section 1 (Config Schema) for type definitions

## Implementation Tasks

### 1. Create `types.ts`

```typescript
// /home/ignacio/pr/pi-edit-hooks/types.ts
```

Define these types:

#### Command value types
```typescript
/** A single command, sequential array, or disable marker */
export type CommandValue = string | string[] | false

/** Maps glob patterns to commands */
export type GlobCommands = Record<string, CommandValue>
```

#### Flat config format
```typescript
export interface FlatConfig {
  onEdit?: GlobCommands | false
  onStop?: GlobCommands | false
  /** Workspace manifest override for {files} grouping */
  workspace?: string | Record<string, string> | false
}
```

#### Path-keyed config format
```typescript
/**
 * Keys are paths relative to config file location.
 * "." = root default, "frontend/" = subdirectory scope.
 * `false` disables all checks for that subtree.
 */
export type PathKeyedConfig = Record<string, FlatConfig | false>
```

#### Union type for raw config
```typescript
/** Config as read from disk (before resolution) */
export type RawConfig = FlatConfig | PathKeyedConfig
```

#### Resolved config (after path matching and merging)
```typescript
/** The final config used for a specific file */
export interface ResolvedConfig {
  onEdit: GlobCommands | null    // null = disabled or not defined
  onStop: GlobCommands | null
  projectRoot: string            // directory containing the config file
}
```

#### Discovery result types
```typescript
export interface FoundConfig {
  config: RawConfig
  configDir: string   // directory containing .pi/ (i.e., parent of .pi/)
}

export interface SessionState {
  boundary: string              // git root or cwd fallback
  editedFiles: Set<string>      // accumulated since last agent_end
}
```

#### Command execution types
```typescript
export interface RunResult {
  stdout: string
  stderr: string
  failed: boolean
}

export type HookMode = 'onEdit' | 'onStop'
```

### 2. Add type guard for path-keyed detection

```typescript
/**
 * Detect if a config uses path-keyed format.
 * Path-keyed if ANY top-level key contains '/' or equals '.'
 */
export function isPathKeyedConfig(config: RawConfig): config is PathKeyedConfig {
  return Object.keys(config).some(key => key === '.' || key.includes('/'))
}
```

### 3. Export from types.ts

All types should be exported. The file should be self-contained with no imports from other project files.

## Acceptance Criteria

```bash
cd /home/ignacio/pr/pi-edit-hooks

# 1. File exists
test -f types.ts

# 2. TypeScript syntax valid
npx tsc --noEmit types.ts 2>&1 | grep -v "Cannot find module" || true
# Should have no errors (module resolution errors are OK at this stage)

# 3. All required types are exported
grep -q "export type CommandValue" types.ts
grep -q "export type GlobCommands" types.ts
grep -q "export interface FlatConfig" types.ts
grep -q "export type PathKeyedConfig" types.ts
grep -q "export type RawConfig" types.ts
grep -q "export interface ResolvedConfig" types.ts
grep -q "export interface FoundConfig" types.ts
grep -q "export interface SessionState" types.ts
grep -q "export interface RunResult" types.ts
grep -q "export type HookMode" types.ts
grep -q "export function isPathKeyedConfig" types.ts
```

## Reviewer Instructions

1. Verify all types match the design spec in `/tmp/plan-architecture.md`
2. Confirm no hardcoded defaults appear in types
3. Check that `workspace` field is included in FlatConfig (for {files} grouping override)
4. Verify the type guard function is correct (checks for '.' or '/')
