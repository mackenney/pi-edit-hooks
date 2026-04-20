# Step 08: Package Configuration

## Context

The package needs proper npm configuration for both pi extension loading and Claude Code CLI compatibility. This step creates/updates `package.json` and adds an example config file.

**Overall objective:** Redesign format-check into pi-edit-hooks with onEdit/onStop hooks, path-keyed configs, and workspace grouping.

**This step:** Configure package.json and create example config.

## Prerequisites

- Step 06 (index.ts) and Step 07 (cli.mjs) completed

## Files to Read

- `/home/ignacio/pr/pi-edit-hooks/` — check if package.json exists
- `/tmp/plan-hooks.md` — section 5 (package.json Structure)

## Implementation Tasks

### 1. Create or update `package.json`

```json
{
  "name": "pi-edit-hooks",
  "version": "0.1.0",
  "description": "Code quality hooks for pi coding agent — runs checks after file edits",
  "type": "module",
  "keywords": [
    "pi-package",
    "pi-coding-agent",
    "extension",
    "format",
    "lint",
    "typecheck"
  ],
  "pi": {
    "extension": "./index.ts"
  },
  "bin": {
    "pi-edit-hooks": "./cli.mjs"
  },
  "files": [
    "index.ts",
    "types.ts",
    "glob.ts",
    "substitute.ts",
    "discover.ts",
    "resolve.ts",
    "core.ts",
    "cli.mjs"
  ],
  "repository": {
    "type": "git",
    "url": "https://github.com/user/pi-edit-hooks"
  },
  "author": "",
  "license": "MIT"
}
```

**Key fields:**
- `type: "module"` — ESM module
- `pi.extension` — entry point for pi extension loading (TypeScript, no build)
- `bin` — CLI for Claude Code compatibility
- `files` — list of files to include in npm package
- `keywords` — includes `pi-package` for discovery

### 2. Create `edit-hooks.example.json`

An example config demonstrating both flat and path-keyed formats:

```json
{
  "_comment": "Example pi-edit-hooks configuration",
  "_comment2": "Copy to .pi/edit-hooks.json in your project or ~/.pi/agent/edit-hooks.json globally",
  
  "onEdit": {
    "*.py": "python3 -c 'import ast,sys;ast.parse(open(sys.argv[1]).read(),sys.argv[1])' {file}",
    "*.{js,mjs,cjs}": "node --check {file}",
    "*.{ts,tsx}": "node --check {file}",
    "*.json": "python3 -m json.tool {file} >/dev/null"
  },
  
  "onStop": {
    "*.py": "uv run ruff format --force-exclude {files} && uv run ruff check --force-exclude --fix {files} && uv run basedpyright {files}",
    "*.{ts,tsx}": "npx tsc --noEmit"
  }
}
```

### 3. Create `edit-hooks.path-keyed.example.json`

An example showing path-keyed format:

```json
{
  "_comment": "Path-keyed config example — different settings per subdirectory",
  
  ".": {
    "onEdit": {
      "*.py": "python3 -c 'import ast,sys;ast.parse(open(sys.argv[1]).read(),sys.argv[1])' {file}"
    },
    "onStop": {
      "*.py": "uv run ruff check --force-exclude {files}"
    }
  },
  
  "legacy/": false,
  
  "packages/frontend/": {
    "onEdit": {
      "*.{ts,tsx}": "node --check {file}"
    },
    "onStop": {
      "*.{ts,tsx}": "npx biome check {files}"
    }
  }
}
```

### 4. Update `.gitignore` if needed

Ensure these are ignored:
```
node_modules/
*.log
.DS_Store
```

## Acceptance Criteria

```bash
cd /home/ignacio/pr/pi-edit-hooks

# 1. package.json exists and is valid JSON
test -f package.json
node -e "JSON.parse(require('fs').readFileSync('package.json'))"

# 2. Required fields present
node -e "
const pkg = JSON.parse(require('fs').readFileSync('package.json'))
console.assert(pkg.name === 'pi-edit-hooks', 'name')
console.assert(pkg.type === 'module', 'type')
console.assert(pkg.pi?.extension === './index.ts', 'pi.extension')
console.assert(pkg.bin?.['pi-edit-hooks'] === './cli.mjs', 'bin')
console.assert(pkg.keywords?.includes('pi-package'), 'keywords')
console.log('package.json valid')
"

# 3. Example config exists and is valid JSON
test -f edit-hooks.example.json
node -e "JSON.parse(require('fs').readFileSync('edit-hooks.example.json'))"

# 4. Path-keyed example exists
test -f edit-hooks.path-keyed.example.json
node -e "JSON.parse(require('fs').readFileSync('edit-hooks.path-keyed.example.json'))"

# 5. Examples have correct structure
node -e "
const flat = JSON.parse(require('fs').readFileSync('edit-hooks.example.json'))
console.assert('onEdit' in flat, 'flat has onEdit')
console.assert('onStop' in flat, 'flat has onStop')

const keyed = JSON.parse(require('fs').readFileSync('edit-hooks.path-keyed.example.json'))
console.assert('.' in keyed, 'keyed has root')
console.assert('legacy/' in keyed, 'keyed has legacy')
console.log('examples valid')
"

# 6. All TypeScript files listed in files array
node -e "
const pkg = JSON.parse(require('fs').readFileSync('package.json'))
const required = ['index.ts', 'types.ts', 'glob.ts', 'substitute.ts', 'discover.ts', 'resolve.ts', 'core.ts', 'cli.mjs']
for (const f of required) {
  if (!pkg.files?.includes(f)) {
    console.error('Missing from files:', f)
    process.exit(1)
  }
}
console.log('files array complete')
"
```

## Reviewer Instructions

1. Verify `pi.extension` points to `./index.ts` (TypeScript, no build step)
2. Confirm `type: "module"` is set for ESM
3. Check that `bin` entry preserves CLI compatibility
4. Ensure `files` array includes all production TypeScript/JS files
5. Verify example configs demonstrate both onEdit and onStop
6. Check path-keyed example shows `"."`, `"legacy/": false`, and subdirectory sections
