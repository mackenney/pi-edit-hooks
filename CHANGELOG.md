# Changelog

## 0.2.2 — 2026-05-22

### Compatibility

- Fixed onStop error-case follow-up delivery on pi@0.75.4
- Root cause: pi@0.75.4's awaited agent lifecycle replaced the event queue; `sendMessage` with `triggerTurn:true` during `agent_end` enqueued to a never-drained followUpQueue
- Fix: defer the sendMessage call with `setImmediate()` so it runs after `finishRun()` clears `isStreaming`
- Tested against pi@0.74.2, pi@0.75.4 — both pass

## 0.2.1 — 2026-05-17

### Compatibility

- Updated package scope: `@mariozechner/*` → `@earendil-works/*` at pi@0.75.0 (package rename in pi 0.74.0)
- Tested against pi@0.71.1, pi@0.72.1, pi@0.73.1 — all pass (0.72.1 failure was a transient pi regression, not extension code)

## 0.2.0 — 2026-04-30

### Compatibility

- Tested against pi@0.68.1, pi@0.69.0, pi@0.70.6 — all pass
- Lockfile updated to pi@0.70.6
- `e2e-tests/live.ts` assertions updated to match new output format (missed in initial 0.2.0 commits)

### onEdit output format

- Header changed from `⚠ onEdit: <filepath>` to `⚠ onEdit` — file path was redundant since it is embedded in the substituted command
- Added `config: <path>` line — shows the absolute path of the resolved `edit-hooks.json` (project or global fallback)
- Added `commands: <cmd>` line — shows the exact substituted command that ran, making tool identity unambiguous (e.g. `ty` vs `basedpyright`)
- `runOnEditCommands` now tracks command failure and surfaces it as a UI notification

### onStop output format

- Each result is now prefixed with `$ <cmd>` on its own line before the `✓`/`✗` output
- Successful commands with output are now delivered as informational follow-ups (`triggerTurn: false`) instead of being silently dropped
- Added singleton dispatch path for commands with no `{file}` or `{files}` placeholder (e.g. `tsc --noEmit`)

### Model awareness

- `before_agent_start` injects a two-line "Edit Hooks" section into the system prompt each turn, describing what `onEdit` and `onStop` are and what their output contains. The text is a stable literal — no cache busting.

### `ResolvedConfig.configSource`

- New field on `ResolvedConfig` carrying the absolute path to the resolved `edit-hooks.json`. Used in onEdit output; available to callers for diagnostics.

### `substituteVars` — auto-append removed

- Commands without `{file}` or `{files}` placeholders now run as-is. Previously they had the appropriate placeholder appended automatically. This enables singleton commands like `tsc --noEmit` that operate on the whole project rather than individual files.
- `onStop` dispatch now has three explicit paths: `{files}` batch, `{file}` per-file, and singleton (no placeholder).
- Example configs and `edit-hooks.example.json` updated: `node --check` replaced by `esbuild {file} > /dev/null` for `*.{ts,tsx}`; `basedpyright` replaced by `ty`.

### `node_modules/.bin` in PATH

- `runCommand` now prepends `<cwd>/node_modules/.bin` to `PATH` before executing hook commands, matching how `npm run` scripts work. Project-local binaries (`biome`, `tsc`, `eslint`, etc.) resolve by name without `npx`.

### Tests

- `e2e-tests/run.sh` test 1: fixed injection test to use `echo {file}` — the old `echo` with no placeholder never substituted a path after auto-append was removed, making the single-quote safety check vacuous
- `test-repos/verify.sh`: updated substitution tests to reflect no-auto-append behaviour; added explicit singleton case
- `mock-server.test.ts` and `real-api.test.ts`: updated assertions for new output format (`⚠ onEdit` without path, `config:`, `commands:`), new onStop message prefix (`onStop checks after edits`), and new informational follow-up behaviour for clean runs
