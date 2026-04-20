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
