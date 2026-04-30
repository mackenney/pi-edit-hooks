# pi-edit-hooks

Code quality hooks for the [pi coding agent](https://shittycodingagent.ai).

Runs syntax checks inline as the agent edits files (`onEdit`) and runs
format/lint/typecheck at the end of each turn (`onStop`).

## Install

```bash
pi install npm:pi-edit-hooks
```

## Configuration

Create `.pi/edit-hooks.json` in your project, or globally at `~/.pi/agent/edit-hooks.json`.

## Hooks

| Hook | Trigger | Behavior | Variables |
|------|---------|----------|-----------|
| `onEdit` | After each `write`/`edit` tool call | Appends output to tool result (informational, never blocks). Shows resolved config file and command executed. | `{file}` |
| `onStop` | After agent turn ends | Sends a follow-up message with each command and its output. Errors trigger a new agent turn; clean output is informational only. | `{files}`, `{file}` |

## Variables

- `{file}` — absolute path of the edited file
- `{files}` — space-separated absolute paths of all files edited in the current turn, grouped by project (see below)
- `{projectRoot}` — directory containing the `.pi/` folder

Commands without a placeholder run as-is (useful for project-wide tools like `npx tsc --noEmit`).

## Monorepo File Grouping

In monorepos, `{files}` is not a flat list of every edited file. Instead,
pi-edit-hooks groups files by their nearest workspace manifest (`pyproject.toml`,
`package.json`, `go.mod`, etc.) and runs the `onStop` command once per group,
with `{files}` containing only the files that belong to that manifest's project
and `{projectRoot}` pointing to its directory.

This means tools like `ruff`, `tsc`, and `go vet` are always invoked from the
correct project root with the correct subset of files — no cross-project
contamination and no need to wrangle paths manually.

## Array Commands

A command value can be a string or an array of strings. When an array is given,
each command runs in sequence and a non-zero exit from any step stops the chain:

```json
"*.py": [
  "uv run ruff format {files}",
  "uv run ruff check --fix {files}",
  "uv run basedpyright {files}"
]
```

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

## Example Configurations

Minimal project setup:

```json
{
  "onEdit": {
    "*.py": "python3 -c 'import ast,sys;ast.parse(open(sys.argv[1]).read())' {file}",
    "*.{js,mjs,ts,tsx}": "node --check {file}"
  },
  "onStop": {
    "*.py": [
      "uv run ruff format {files}",
      "uv run ruff check --fix {files}",
      "uv run basedpyright {files}"
    ],
    "*.{ts,tsx}": "npx tsc --noEmit"
  }
}
```

Monorepo with per-subtree overrides:

```json
{
  ".": {
    "onEdit": { "*.py": "python3 -c 'import ast,sys;ast.parse(open(sys.argv[1]).read())' {file}" },
    "onStop": {
      "*.py": [
        "uv run ruff format {files}",
        "uv run ruff check --fix {files}",
        "uv run basedpyright {files}"
      ]
    }
  },
  "legacy/": false,
  "packages/frontend/": {
    "onStop": { "*.{ts,tsx}": "npx biome check {files}" }
  }
}
```
