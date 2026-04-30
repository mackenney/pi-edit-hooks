# Changelog

## 0.2.0 — 2026-04-30

### onEdit output format

- Header changed from `⚠ onEdit: <filepath>` to `⚠ onEdit` — file path was redundant since it is embedded in the substituted command
- Added `config: <path>` line — shows the absolute path of the resolved `edit-hooks.json` (project or global fallback)
- Added `commands: <cmd>` line — shows the exact substituted command that ran, making tool identity unambiguous (e.g. `ty` vs `basedpyright`)
- `runOnEditCommands` now tracks command failure and surfaces it as a UI notification

### onStop output format

- Each result is now prefixed with `$ <cmd>` on its own line before the `✓`/`✗` output
- Successful commands with output are now delivered as informational follow-ups (`triggerTurn: false`) instead of being silently dropped
- Added singleton dispatch path for commands with no `{file}` or `{files}` placeholder (e.g. `npx tsc --noEmit`)

### Model awareness

- `before_agent_start` injects a two-line "Edit Hooks" section into the system prompt each turn, describing what `onEdit` and `onStop` are and what their output contains. The text is a stable literal — no cache busting.

### `ResolvedConfig.configSource`

- New field on `ResolvedConfig` carrying the absolute path to the resolved `edit-hooks.json`. Used in onEdit output; available to callers for diagnostics.

### `substituteVars` — auto-append removed

- Commands without `{file}` or `{files}` placeholders now run as-is. Previously they had the appropriate placeholder appended automatically. This enables singleton commands like `npx tsc --noEmit` that operate on the whole project rather than individual files.
- `onStop` dispatch now has three explicit paths: `{files}` batch, `{file}` per-file, and singleton (no placeholder).

### Tests

- `e2e-tests/run.sh` test 1: fixed injection test to use `echo {file}` — the previous `echo` (no placeholder) never substituted a path, so the single-quote check was vacuously testing nothing after auto-append was removed
- `test-repos/verify.sh`: updated substitution tests to reflect no-auto-append behaviour; added explicit singleton case
- `mock-server.test.ts` and `real-api.test.ts`: updated assertions for new output format (`⚠ onEdit` without path, `config:`, `commands:`), new onStop message prefix (`onStop checks after edits`), and new informational follow-up behaviour for clean runs
