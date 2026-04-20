# Step 07: CLI Migration

## Context

The `cli.mjs` file provides Claude Code compatibility via the `accumulate` and `check` subcommands. This step migrates it from the old format/lint/typecheck schema to the new onEdit/onStop schema while preserving the core mechanics.

**Overall objective:** Redesign format-check into pi-edit-hooks with onEdit/onStop hooks, path-keyed configs, and workspace grouping.

**This step:** Update cli.mjs to use new config structure and onStop semantics.

## Prerequisites

- Step 01–05 completed (core modules available for reference)

## Files to Read

- `/home/ignacio/pr/pi-edit-hooks/cli.mjs` — current implementation
- `/tmp/plan-hooks.md` — section 4 (cli.mjs Schema Migration)

## Implementation Tasks

### 1. Update config file references

Change from `.agent/tools.json` to `.pi/edit-hooks.json`:

```javascript
const CONFIG_DIR = '.pi'
const CONFIG_FILE = 'edit-hooks.json'
```

### 2. Remove old defaults

Delete these constants:
- `DEFAULT_FORMAT`
- `DEFAULT_LINT`
- `DEFAULT_TYPECHECK`

**Important:** The CLI should have NO hardcoded defaults. If no config exists, `check` exits cleanly with no checks run.

### 3. Add global config fallback

```javascript
import { homedir } from 'node:os'
import { join } from 'node:path'

const GLOBAL_CONFIG_PATH = join(homedir(), '.pi', 'agent', CONFIG_FILE)
const GLOBAL_CONFIG_DIR = join(homedir(), '.pi', 'agent')

function findConfigWithGlobalFallback(filePath) {
  const local = findConfig(filePath)
  if (local) return local
  if (existsSync(GLOBAL_CONFIG_PATH)) {
    return { path: GLOBAL_CONFIG_PATH, dir: GLOBAL_CONFIG_DIR }
  }
  return null
}
```

### 4. Add path-keyed detection and resolution

```javascript
function isPathKeyed(config) {
  return Object.keys(config).some(key => key === '.' || key.includes('/'))
}

function resolvePathKeyedSection(config, filePath, configDir) {
  const absFile = resolve(filePath)
  const relPath = absFile.startsWith(configDir + '/') 
    ? absFile.slice(configDir.length + 1) 
    : null
  
  if (!relPath) return null
  
  const matches = []
  for (const [key, section] of Object.entries(config)) {
    if (key === '.') {
      matches.push({ key, length: 0, section })
    } else {
      const normalizedKey = key.replace(/\/$/, '')
      if (relPath === normalizedKey || relPath.startsWith(normalizedKey + '/')) {
        matches.push({ key, length: normalizedKey.length, section })
      }
    }
  }
  
  if (matches.length === 0) return null
  matches.sort((a, b) => b.length - a.length)
  return matches[0].section
}
```

### 5. Update section resolution

Replace `resolveSection` to handle onStop only (CLI check command = onStop):

```javascript
function resolveOnStopSection(config, filePath, configDir) {
  if (config === null) return null
  
  let flatConfig = config
  if (isPathKeyed(config)) {
    const section = resolvePathKeyedSection(config, filePath, configDir)
    if (section === false) return null  // disabled
    flatConfig = section
  }
  
  if (!flatConfig) return null
  
  const val = flatConfig.onStop
  if (val === false) return null
  if (val && typeof val === 'object') return val
  return null
}
```

### 6. Update auto-append logic

Add `{files}` auto-append when neither placeholder present:

```javascript
function substituteVars(cmd, file, projectRoot, configDir, allFiles) {
  const absFile = resolve(file)
  let result = cmd
  
  // Resolve relative paths
  if (result.startsWith('./') || result.startsWith('../')) {
    result = join(configDir, result)
  }
  
  // Auto-append {files} if no placeholder present (onStop mode)
  const hasPlaceholder = result.includes('{file}') || result.includes('{files}')
  if (!hasPlaceholder) {
    result = result + ' {files}'
  }
  
  result = result.replace(/\{file\}/g, `"${absFile}"`)
  result = result.replace(/\{projectRoot\}/g, `"${projectRoot}"`)
  
  const filesArgs = allFiles
    ? allFiles.map((f) => `"${resolve(f)}"`).join(' ')
    : `"${absFile}"`
  result = result.replace(/\{files\}/g, filesArgs)
  
  return result
}
```

### 7. Rewrite check() function

```javascript
async function check() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  const data = JSON.parse(raw)
  const { session_id: sessionId, stop_hook_active: stopHookActive } = data

  // Loop guard
  if (stopHookActive === true) process.exit(0)

  const listFile = `/tmp/agent-edits-${sessionId}`
  if (!existsSync(listFile)) process.exit(0)

  // Read, deduplicate, and clear
  const content = readFileSync(listFile, 'utf8')
  writeFileSync(listFile, '', 'utf8')
  const files = [...new Set(content.split('\n').map(f => f.trim()).filter(Boolean))]

  if (files.length === 0) process.exit(0)

  const allErrors = []
  const liveFiles = files.filter((f) => existsSync(f))

  // Group by manifest
  const groups = groupFilesByManifest(liveFiles)

  for (const [groupDir, groupFiles] of groups) {
    const found = findConfigWithGlobalFallback(groupFiles[0])
    if (!found) continue  // No config = no checks
    
    const config = loadConfig(found.path)
    const configDir = found.dir
    const cwd = groupDir

    const onStopGlobs = resolveOnStopSection(config, groupFiles[0], configDir)
    if (!onStopGlobs) continue  // onStop disabled or not defined

    const groupErrors = []

    // Bucket files by matching command
    const cmdToFiles = new Map()
    for (const file of groupFiles) {
      const rawCmd = findCommand(onStopGlobs, file)
      if (!rawCmd) continue
      const bucket = cmdToFiles.get(rawCmd) ?? []
      bucket.push(file)
      cmdToFiles.set(rawCmd, bucket)
    }

    for (const [rawCmd, matchedFiles] of cmdToFiles) {
      // Check if uses batch mode
      const usesBatch = rawCmd.includes('{files}') || 
                        (!rawCmd.includes('{file}') && !rawCmd.includes('{files}'))
      
      if (usesBatch) {
        const cmd = substituteVars(rawCmd, matchedFiles[0], cwd, configDir, matchedFiles)
        const result = await runCommand(cmd, cwd, CHECKS_TIMEOUT_MS)
        if (result.failed) {
          const output = (result.stderr + result.stdout).trim()
          if (output) groupErrors.push(`[onStop] ${output}`)
        }
      } else {
        for (const file of matchedFiles) {
          const cmd = substituteVars(rawCmd, file, cwd, configDir)
          const result = await runCommand(cmd, cwd, CHECKS_TIMEOUT_MS)
          if (result.failed) {
            const output = (result.stderr + result.stdout).trim()
            if (output) groupErrors.push(`[onStop] ${output}`)
          }
        }
      }
    }

    if (groupErrors.length > 0) {
      allErrors.push(`${groupDir}\n${groupErrors.join('\n')}`)
    }
  }

  if (allErrors.length > 0) {
    process.stderr.write(
      `Checks failed after edits:\n\n${allErrors.join('\n\n')}\n`
    )
    process.exit(2)
  }

  process.exit(0)
}
```

### 8. Keep accumulate() unchanged

The `accumulate` subcommand just stores file paths — no changes needed.

## Acceptance Criteria

```bash
cd /home/ignacio/pr/pi-edit-hooks

# 1. File exists
test -f cli.mjs

# 2. Node can parse it
node --check cli.mjs

# 3. Uses new config paths
grep -q "'\.pi'" cli.mjs || grep -q '"\\.pi"' cli.mjs
grep -q "edit-hooks.json" cli.mjs

# 4. No old defaults
! grep -q "DEFAULT_FORMAT" cli.mjs
! grep -q "DEFAULT_LINT" cli.mjs
! grep -q "DEFAULT_TYPECHECK" cli.mjs

# 5. Has global fallback
grep -q "homedir" cli.mjs
grep -q "GLOBAL_CONFIG" cli.mjs

# 6. Has path-keyed support
grep -q "isPathKeyed" cli.mjs
grep -q "resolvePathKeyedSection" cli.mjs

# 7. Auto-append logic present
grep -q "{files}" cli.mjs

# 8. Uses [onStop] prefix in errors
grep -q '\[onStop\]' cli.mjs

# 9. CLI subcommands still work
echo '{"session_id": "test-123"}' | node cli.mjs check
# Should exit 0 (no files accumulated)
```

## Reviewer Instructions

1. Verify config path changed from `.agent/tools.json` to `.pi/edit-hooks.json`
2. Confirm all `DEFAULT_*` constants are removed
3. Check global fallback path: `~/.pi/agent/edit-hooks.json`
4. Verify path-keyed resolution matches the TypeScript implementation
5. Ensure auto-append adds `{files}` (not `{file}`) since CLI is onStop-only
6. Confirm error format uses `[onStop]` prefix
7. Check that missing config = no checks (not error)
