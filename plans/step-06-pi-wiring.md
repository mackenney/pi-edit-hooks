# Step 06: Pi Extension Event Wiring

## Context

The pi extension hooks into three events: `session_start` (initialize state), `tool_result` (onEdit checks), and `agent_end` (onStop checks). This step rewrites `index.ts` with proper session state management and the new hook semantics.

**Overall objective:** Redesign format-check into pi-edit-hooks with onEdit/onStop hooks, path-keyed configs, and workspace grouping.

**This step:** Wire up pi event handlers with session state, boundary detection, and informational/fatal semantics.

## Prerequisites

- Step 01–05 completed (types, glob, substitute, discover, resolve)

## Files to Read

- `/home/ignacio/pr/pi-edit-hooks/index.ts` — current implementation
- `/home/ignacio/pr/pi-edit-hooks/core.ts` — `runCommand`, `groupFilesByManifest`
- `/tmp/plan-hooks.md` — full plan for event wiring

## Implementation Tasks

### 1. Rewrite `index.ts`

```typescript
// /home/ignacio/pr/pi-edit-hooks/index.ts
```

### 2. Import dependencies

```typescript
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { SessionState, GlobCommands, HookMode } from './types.ts'
import { findCommand, normalizeCommand } from './glob.ts'
import { substituteVars } from './substitute.ts'
import { getGitRoot } from './discover.ts'
import { resolveConfig } from './resolve.ts'
import { runCommand, groupFilesByManifest, CHECKS_TIMEOUT_MS, SYNTAX_TIMEOUT_MS } from './core.ts'
```

### 3. Session state management

```typescript
let state: SessionState | null = null

function ensureState(cwd: string): SessionState {
  if (!state) {
    // Defensive fallback — should not happen if session_start fires first
    state = { boundary: cwd, editedFiles: new Set() }
  }
  return state
}
```

### 4. Implement `runOnEditCommands` helper

```typescript
/**
 * Run onEdit commands for a single file.
 * Returns output to append to tool result, or null if no output.
 */
async function runOnEditCommands(
  filePath: string,
  globs: GlobCommands,
  projectRoot: string,
): Promise<string | null> {
  const commandValue = findCommand(globs, filePath)
  if (commandValue === null) return null
  
  const commands = normalizeCommand(commandValue)
  if (!commands) return null
  
  const outputs: string[] = []
  
  for (const rawCmd of commands) {
    const cmd = substituteVars(rawCmd, {
      file: filePath,
      projectRoot,
      configDir: projectRoot,
      mode: 'onEdit' as HookMode,
    })
    
    const result = await runCommand(cmd, projectRoot, SYNTAX_TIMEOUT_MS)
    
    // Collect output regardless of success/failure (informational)
    const output = (result.stderr + result.stdout).trim()
    if (output) {
      outputs.push(output)
    }
  }
  
  return outputs.length > 0 ? outputs.join('\n') : null
}
```

### 5. Implement `runOnStopForGroup` helper

```typescript
/**
 * Run onStop commands for a group of files sharing the same manifest.
 * Returns array of error messages.
 */
async function runOnStopForGroup(
  files: string[],
  cwd: string,
  globs: GlobCommands,
  projectRoot: string,
): Promise<string[]> {
  const errors: string[] = []
  
  // Bucket files by matching command (same command = batch together)
  const cmdToFiles = new Map<string, string[]>()
  
  for (const file of files) {
    const commandValue = findCommand(globs, file)
    if (commandValue === null) continue
    
    const commands = normalizeCommand(commandValue)
    if (!commands) continue
    
    // Use the raw command template as the bucket key
    for (const rawCmd of commands) {
      const bucket = cmdToFiles.get(rawCmd) ?? []
      bucket.push(file)
      cmdToFiles.set(rawCmd, bucket)
    }
  }
  
  for (const [rawCmd, matchedFiles] of cmdToFiles) {
    // Check if command uses {files} (batch) or {file} (per-file)
    const usesBatch = rawCmd.includes('{files}') || 
                      (!rawCmd.includes('{file}') && !rawCmd.includes('{files}'))
    // Auto-append adds {files} for onStop, so commands without placeholders are batch
    
    if (usesBatch) {
      // Single invocation for all files
      const cmd = substituteVars(rawCmd, {
        file: matchedFiles[0],
        files: matchedFiles,
        projectRoot,
        configDir: projectRoot,
        mode: 'onStop' as HookMode,
      })
      
      const result = await runCommand(cmd, cwd, CHECKS_TIMEOUT_MS)
      if (result.failed) {
        const output = (result.stderr + result.stdout).trim()
        if (output) errors.push(`[onStop] ${output}`)
      }
    } else {
      // Per-file invocation
      for (const file of matchedFiles) {
        const cmd = substituteVars(rawCmd, {
          file,
          projectRoot,
          configDir: projectRoot,
          mode: 'onStop' as HookMode,
        })
        
        const result = await runCommand(cmd, cwd, CHECKS_TIMEOUT_MS)
        if (result.failed) {
          const output = (result.stderr + result.stdout).trim()
          if (output) errors.push(`[onStop] ${output}`)
        }
      }
    }
  }
  
  return errors
}
```

### 6. Implement the extension

```typescript
export default function (pi: ExtensionAPI) {
  // ── session_start: Initialize boundary and state ──
  pi.on('session_start', async (_event, ctx) => {
    const boundary = await getGitRoot(ctx.cwd) ?? ctx.cwd
    state = { boundary, editedFiles: new Set() }
  })

  // ── tool_result: onEdit hooks (informational) ──
  pi.on('tool_result', async (event, ctx) => {
    if (event.isError) return
    if (event.toolName !== 'write' && event.toolName !== 'edit') return
    
    const filePath = (event.input as { path?: string }).path
    if (!filePath) return
    
    const absPath = resolve(filePath)
    if (!existsSync(absPath)) return
    
    // Always accumulate, even if no onEdit commands match
    const s = ensureState(ctx.cwd)
    s.editedFiles.add(absPath)
    
    // Resolve config for this file
    const config = resolveConfig(absPath, s.boundary)
    if (!config || !config.onEdit) return
    
    const output = await runOnEditCommands(absPath, config.onEdit, config.projectRoot)
    if (!output) return
    
    // Append output to tool result (informational, never blocks)
    return {
      content: [
        ...event.content,
        {
          type: 'text' as const,
          text: `\n⚠ onEdit: ${filePath}\n\`\`\`\n${output}\n\`\`\``,
        },
      ],
    }
  })

  // ── agent_end: onStop hooks (fatal) ──
  pi.on('agent_end', async (_event, ctx) => {
    const s = ensureState(ctx.cwd)
    const files = [...s.editedFiles].filter(f => existsSync(f))
    s.editedFiles.clear()
    
    if (files.length === 0) return
    
    const allErrors: string[] = []
    
    // Group files by nearest workspace manifest
    // Use first file's config for grouping (workspace key)
    const firstConfig = resolveConfig(files[0], s.boundary)
    const groups = groupFilesByManifest(files, firstConfig ? { workspace: undefined } : null)
    
    for (const [groupDir, groupFiles] of groups) {
      // Resolve config for this group (may differ from other groups)
      const config = resolveConfig(groupFiles[0], s.boundary)
      if (!config || !config.onStop) continue
      
      const errors = await runOnStopForGroup(
        groupFiles,
        groupDir,
        config.onStop,
        config.projectRoot,
      )
      
      if (errors.length > 0) {
        allErrors.push(`**${groupDir}**\n${errors.join('\n')}`)
      }
    }
    
    if (allErrors.length === 0) return
    
    // Send followUp to force agent to address errors
    pi.sendUserMessage(
      `Checks failed after edits. Fix the following issues:\n\n${allErrors.join('\n\n')}`,
      { deliverAs: 'followUp' },
    )
  })
}
```

## Acceptance Criteria

```bash
cd /home/ignacio/pr/pi-edit-hooks

# 1. File exists with expected structure
test -f index.ts

# 2. TypeScript syntax valid
npx tsc --noEmit index.ts types.ts glob.ts substitute.ts discover.ts resolve.ts core.ts 2>&1 | grep -v "Cannot find module '@mariozechner" || true

# 3. Registers all three event handlers
grep -q "pi.on('session_start'" index.ts
grep -q "pi.on('tool_result'" index.ts
grep -q "pi.on('agent_end'" index.ts

# 4. Uses getGitRoot for boundary detection
grep -q "getGitRoot" index.ts

# 5. Uses sendUserMessage with followUp for onStop failures
grep -q "deliverAs: 'followUp'" index.ts

# 6. onEdit output format is informational
grep -q "⚠ onEdit:" index.ts

# 7. Accumulates files in editedFiles Set
grep -q "editedFiles.add" index.ts
grep -q "editedFiles.clear" index.ts
```

## Reviewer Instructions

1. Verify `session_start` initializes both `boundary` and `editedFiles`
2. Confirm `tool_result` always accumulates files (even if no commands match)
3. Check that onEdit output format is terse (no "Fix before continuing")
4. Verify onStop uses `sendUserMessage` with `deliverAs: 'followUp'` (fatal)
5. Ensure workspace grouping is used for onStop file batching
6. Confirm batch detection logic: commands without `{file}` explicitly are batched
