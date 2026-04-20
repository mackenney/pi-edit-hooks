# Step 10: npm Publish Setup

## Context

This step makes `pi-edit-hooks` a properly structured, npm-publishable pi package. It corrects the incomplete package.json from step 08, adds the mandatory `peerDependencies` for pi core packages (so they are never bundled), configures `publishConfig` for public npm access, and ensures `pi.extensions` uses the correct **array form with a single entry** — which is what pi reads to show exactly one line in the `[extensions]` startup section.

**Why step 08 is not sufficient:**
- Uses `"pi": { "extension": "./index.ts" }` — the key is `extension` (singular), which pi does not recognize. The correct key is `"extensions"` (plural, array). See `packages.md` and the real-world `@aliou/pi-processes` reference.
- Missing `peerDependencies` for `@mariozechner/pi-coding-agent`. Per `packages.md`: *"list them in `peerDependencies` with a `"*"` range and do not bundle them"*.
- Missing `publishConfig.access: "public"` (needed for scoped packages; good practice for all).
- Missing `devDependencies` structure for type-checking during development.
- `files` array lists individual `.ts` files instead of directories — fine, but brittle as new source files are added.
- No `README.md` for the npm package page.
- No `scripts` for typecheck/publish workflow.

**Single-file appearance in `[extensions]`:**  
Pi resolves each entry in `pi.extensions` into one loaded extension. By declaring `"extensions": ["./index.ts"]`, the package contributes exactly one entry to the `[extensions]` section at startup, regardless of how many helper modules `index.ts` imports internally.

**Overall objective:** Redesign `format-check` into `pi-edit-hooks` with onEdit/onStop hooks, path-keyed configs, and workspace grouping.

**This step:** Produce a correct, publish-ready `package.json`; add `README.md`; verify packaging output.

## Prerequisites

- Steps 01–09 completed (all source files exist)

## Files to Read

- `/home/ignacio/pr/pi-edit-hooks/plans/step-08-package.md` — original (incorrect) package config intent
- `/home/ignacio/.nvm/versions/node/v24.14.1/lib/node_modules/@mariozechner/pi-coding-agent/docs/packages.md` — canonical pi package rules
- `/home/ignacio/.nvm/versions/node/v24.14.1/lib/node_modules/@aliou/pi-processes/package.json` — real-world reference

## Implementation Tasks

### 1. Create `package.json`

Replace any existing `package.json`. All fields below are required.

```json
{
  "name": "pi-edit-hooks",
  "version": "0.1.0",
  "description": "Code quality hooks for the pi coding agent — runs syntax checks on edit and format/lint/typecheck at turn end",
  "type": "module",
  "license": "MIT",
  "keywords": [
    "pi-package",
    "pi-extension",
    "pi",
    "format",
    "lint",
    "typecheck",
    "hooks"
  ],
  "repository": {
    "type": "git",
    "url": "https://github.com/ignaciolarranaga/pi-edit-hooks"
  },
  "pi": {
    "extensions": [
      "./index.ts"
    ]
  },
  "publishConfig": {
    "access": "public"
  },
  "files": [
    "src",
    "index.ts",
    "cli.mjs",
    "README.md",
    "edit-hooks.example.json",
    "edit-hooks.path-keyed.example.json"
  ],
  "bin": {
    "pi-edit-hooks": "./cli.mjs"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "prepublishOnly": "npm run typecheck",
    "pack:preview": "npm pack --dry-run"
  },
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": "*"
  },
  "peerDependenciesMeta": {
    "@mariozechner/pi-coding-agent": {
      "optional": true
    }
  },
  "devDependencies": {
    "@mariozechner/pi-coding-agent": "*",
    "@types/node": "^22.0.0",
    "typescript": "^5.0.0"
  }
}
```

**Key decisions:**

| Field | Value | Reason |
|-------|-------|--------|
| `pi.extensions` | `["./index.ts"]` | Array form (plural) is what pi reads; single entry = one line in `[extensions]` |
| `peerDependencies` | `@mariozechner/pi-coding-agent: "*"` | Per `packages.md`: never bundle pi core; `*` range means "any version that pi provides" |
| `peerDependenciesMeta.optional` | `true` | Prevents npm install warnings when used in non-pi environments (e.g., running the CLI only) |
| `devDependencies` | pi core packages | Available for TypeScript type-checking during development; not shipped |
| `publishConfig.access` | `"public"` | Required for scoped packages; harmless for unscoped ones |
| `type` | `"module"` | ESM throughout; needed for `cli.mjs` and jiti resolution |
| `files` | `["src", "index.ts", "cli.mjs", ...]` | Allowlist approach — keeps plan files, test-repos, node_modules out of the tarball |
| `prepublishOnly` | `npm run typecheck` | Prevents publishing with type errors |

> **Note on `@sinclair/typebox`:** `index.ts` imports `Type` from `@sinclair/typebox` for the custom tool
> parameter schema. Per `packages.md`, this is a pi bundled package, so list it in `peerDependencies`
> alongside `@mariozechner/pi-coding-agent` — do **not** add it to `dependencies`.
> Add it to `devDependencies` for local type checking.

If `index.ts` does NOT use `Type` from `@sinclair/typebox` (no custom registered tools), omit it.
If it does, add:
```json
"peerDependencies": {
  "@mariozechner/pi-coding-agent": "*",
  "@sinclair/typebox": "*"
},
"peerDependenciesMeta": {
  "@mariozechner/pi-coding-agent": { "optional": true },
  "@sinclair/typebox": { "optional": true }
},
"devDependencies": {
  "@mariozechner/pi-coding-agent": "*",
  "@sinclair/typebox": "^0.34.0",
  "@types/node": "^22.0.0",
  "typescript": "^5.0.0"
}
```

### 2. Create `tsconfig.json`

Required for `npm run typecheck` to work correctly with jiti-style imports.

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "skipLibCheck": true
  },
  "include": [
    "index.ts",
    "types.ts",
    "glob.ts",
    "substitute.ts",
    "discover.ts",
    "resolve.ts",
    "core.ts"
  ],
  "exclude": [
    "node_modules",
    "test-repos"
  ]
}
```

### 3. Create `README.md`

The README appears on the npm package page and in the pi package gallery.

```markdown
# pi-edit-hooks

Code quality hooks for the [pi coding agent](https://shittycodingagent.ai).

Runs syntax checks inline as the agent edits files (`onEdit`) and runs
format/lint/typecheck at the end of each turn (`onStop`).

## Install

```bash
pi install npm:pi-edit-hooks
```

## Configuration

Create `.pi/edit-hooks.json` in your project:

```json
{
  "onEdit": {
    "*.py": "python3 -c 'import ast,sys;ast.parse(open(sys.argv[1]).read())' {file}",
    "*.{js,mjs,ts,tsx}": "node --check {file}"
  },
  "onStop": {
    "*.py": "uv run ruff format {files} && uv run ruff check --fix {files}",
    "*.{ts,tsx}": "npx tsc --noEmit"
  }
}
```

Or globally at `~/.pi/agent/edit-hooks.json`.

## Hooks

| Hook | Trigger | Behavior | Variables |
|------|---------|----------|-----------|
| `onEdit` | After each `write`/`edit` tool call | Appends output to tool result (informational, never blocks) | `{file}` |
| `onStop` | After agent turn ends | Sends errors as a follow-up message (agent must fix) | `{files}`, `{file}` |

## Variables

- `{file}` — absolute path of the edited file
- `{files}` — space-separated absolute paths of all edited files in the group (onStop only)
- `{projectRoot}` — directory containing the `.pi/` folder

Commands without a placeholder get `{file}` (onEdit) or `{files}` (onStop) appended automatically.

## Path-Keyed Config

Apply different settings per subdirectory:

```json
{
  ".": {
    "onEdit": { "*.py": "python3 -m ast {file}" },
    "onStop": { "*.py": "uv run ruff check {files}" }
  },
  "legacy/": false,
  "packages/frontend/": {
    "onStop": { "*.{ts,tsx}": "npx biome check {files}" }
  }
}
```

`false` disables all hooks for that subtree.

## Claude Code CLI

The package also ships a `pi-edit-hooks` binary compatible with Claude Code's
stop-hook protocol:

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "pi-edit-hooks check" }] }],
    "PostToolUse": [{ "hooks": [{ "type": "command", "command": "pi-edit-hooks accumulate" }] }]
  }
}
```

## License

MIT
```

### 4. Update `files` array if a `src/` directory exists

If the refactoring in steps 01–07 moves modules into a `src/` subdirectory, update `package.json`:

```json
"files": [
  "src",
  "cli.mjs",
  "README.md",
  "edit-hooks.example.json",
  "edit-hooks.path-keyed.example.json"
]
```

If all `.ts` files remain at root level (as the current architecture shows), list them explicitly:

```json
"files": [
  "index.ts",
  "types.ts",
  "glob.ts",
  "substitute.ts",
  "discover.ts",
  "resolve.ts",
  "core.ts",
  "cli.mjs",
  "README.md",
  "edit-hooks.example.json",
  "edit-hooks.path-keyed.example.json"
]
```

Do **not** include `plans/`, `test-repos/`, `tsconfig.json`, `.gitignore`, or `node_modules/`.

### 5. Install dev dependencies

```bash
npm install
```

This creates `node_modules/` with `@mariozechner/pi-coding-agent` (for types) and `typescript` (for typecheck). `node_modules/` is excluded from the npm tarball via the `files` allowlist.

## Acceptance Criteria

```bash
cd /home/ignacio/pr/pi-edit-hooks

# 1. package.json is valid JSON
node -e "JSON.parse(require('fs').readFileSync('package.json'))"

# 2. pi.extensions is an array with a single entry pointing to index.ts
node -e "
const pkg = JSON.parse(require('fs').readFileSync('package.json'))
const exts = pkg.pi?.extensions
console.assert(Array.isArray(exts), 'pi.extensions must be an array')
console.assert(exts.length === 1, 'single extension entry for single [extensions] line')
console.assert(exts[0] === './index.ts', 'entry is ./index.ts')
console.log('pi.extensions OK:', exts)
"

# 3. peerDependencies includes pi core (never bundled)
node -e "
const pkg = JSON.parse(require('fs').readFileSync('package.json'))
const peers = pkg.peerDependencies ?? {}
console.assert('@mariozechner/pi-coding-agent' in peers, 'pi-coding-agent in peerDeps')
console.log('peerDependencies OK:', Object.keys(peers))
"

# 4. No pi core packages in dependencies (must not be bundled)
node -e "
const pkg = JSON.parse(require('fs').readFileSync('package.json'))
const deps = Object.keys(pkg.dependencies ?? {})
const forbidden = ['@mariozechner/pi-coding-agent','@mariozechner/pi-tui','@mariozechner/pi-ai','@mariozechner/pi-agent-core','@sinclair/typebox']
const bad = deps.filter(d => forbidden.includes(d))
console.assert(bad.length === 0, 'pi core packages must not be in dependencies: ' + bad.join(', '))
console.log('dependencies clean')
"

# 5. publishConfig.access is set
node -e "
const pkg = JSON.parse(require('fs').readFileSync('package.json'))
console.assert(pkg.publishConfig?.access === 'public', 'publishConfig.access must be public')
console.log('publishConfig OK')
"

# 6. keywords includes pi-package
node -e "
const pkg = JSON.parse(require('fs').readFileSync('package.json'))
console.assert(pkg.keywords?.includes('pi-package'), 'must have pi-package keyword')
console.log('keywords OK')
"

# 7. type is module
node -e "
const pkg = JSON.parse(require('fs').readFileSync('package.json'))
console.assert(pkg.type === 'module', 'type must be module')
console.log('type OK')
"

# 8. README exists
test -f README.md

# 9. tsconfig.json exists and is valid JSON
test -f tsconfig.json
node -e "JSON.parse(require('fs').readFileSync('tsconfig.json'))"

# 10. TypeScript type check passes
npm run typecheck

# 11. Dry-run pack shows only expected files
npm pack --dry-run 2>&1 | tee /tmp/pack-output.txt
# Must NOT contain: plans/, test-repos/, tsconfig.json, node_modules/
! grep -q "plans/" /tmp/pack-output.txt
! grep -q "test-repos/" /tmp/pack-output.txt
! grep -q "node_modules/" /tmp/pack-output.txt
# Must contain: index.ts, cli.mjs, README.md
grep -q "index.ts" /tmp/pack-output.txt
grep -q "cli.mjs" /tmp/pack-output.txt
grep -q "README.md" /tmp/pack-output.txt

# 12. Simulate pi install resolution — pi reads pi.extensions and finds the file
node -e "
const pkg = JSON.parse(require('fs').readFileSync('package.json'))
const { existsSync } = require('fs')
const { resolve, join } = require('path')
const extPath = join(process.cwd(), pkg.pi.extensions[0])
console.assert(existsSync(extPath), 'index.ts must exist at declared pi.extensions path: ' + extPath)
console.log('Extension file exists at pi.extensions path:', extPath)
"
```

## Reviewer Instructions

1. **Critical**: Confirm `pi.extensions` is the **plural array key** with a single `"./index.ts"` entry — not `"extension"` (singular) as written in step 08.
2. Confirm `@mariozechner/pi-coding-agent` appears in `peerDependencies`, not `dependencies`.
3. Confirm it does NOT appear in `dependencies` (that would cause it to be bundled, breaking pi's module isolation).
4. Check `npm pack --dry-run` output manually — plans, test-repos, and node_modules must not appear.
5. Run `npm run typecheck` and confirm it exits 0.
6. Verify README contains install instructions with the correct `pi install npm:pi-edit-hooks` command.
7. Check that `peerDependenciesMeta` marks pi core as optional (avoids npm install warnings in non-pi contexts).
