# Agent Guidelines — pi-edit-hooks

Multi-file pi extension (`src/`). No build step — TypeScript source loaded directly by pi.
Also ships a `cli.mjs` binary for Claude Code stop-hook integration.

---

## Architecture

```
src/
├── types.ts        — EditHooksConfig, PathKeyedConfig, isPathKeyedConfig type guard
├── glob.ts         — expandBraces, matchesGlob, findCommand, normalizeCommand
├── substitute.ts   — substituteVars + shellQuote (security-critical, see Invariants)
├── discover.ts     — findProjectConfig, getGitRoot (walks up from file to .pi/edit-hooks.json)
├── resolve.ts      — resolveConfig, resolvePathKeyedSection (merges global + project config)
├── core.ts         — runCommand, groupFilesByManifest, SYNTAX_TIMEOUT_MS, CHECKS_TIMEOUT_MS
└── index.ts        — ExtensionAPI wiring:
    ├── before_agent_start — injects onEdit/onStop guidelines into the system prompt
    ├── registerMessageRenderer — renders pi-edit-hooks follow-up messages with color
    ├── session_start      — initializes { boundary, editedFiles } state from git root
    ├── tool_result        — onEdit hooks: runs commands, appends output (config + cmd) to tool result
    └── agent_end          — onStop hooks: runs commands, sends follow-up (infos informational, errors trigger turn)

cli.mjs             — Claude Code binary: accumulate (records edits) + check (runs onStop)
```

**Config resolution:** `findProjectConfig` walks up from the edited file to find
`.pi/edit-hooks.json`. Falls back to `~/.pi/agent/edit-hooks.json`. Path-keyed configs
(keys ending in `/` or `.`) are resolved by `resolvePathKeyedSection`; a `false` value
disables all hooks for that subtree.

**Monorepo grouping:** `groupFilesByManifest` in `core.ts` clusters edited files by their
nearest workspace manifest (`pyproject.toml`, `package.json`, `go.mod`, etc.), so `onStop`
commands run once per project with only the relevant file subset.

**`node_modules/.bin` injection:** `runCommand` prepends `<cwd>/node_modules/.bin` to PATH so project-local tools (`biome`, `tsc`, etc.) work by name — same as `npm run` scripts.

**onEdit return shape:** the handler returns `{ content: [...event.content, newBlock] }` —
always an append, never a replacement.

**onStop delivery:** `pi.sendMessage({ customType: 'pi-edit-hooks', content, display: true }, { deliverAs: 'followUp', triggerTurn })`. Fires on success (infos, `triggerTurn: false`) and on failure (errors, `triggerTurn: true`).

---

## Fragile API surfaces

| Surface | Notes | Known breakage |
|---|---|---|
| `createAgentSession({ tools })` | Was `Tool[]` → became `string[]` in 0.68.0 | pi 0.68.0 |
| `DefaultResourceLoader({ agentDir })` | `agentDir` became required (non-defaulted) in 0.68.0 | pi 0.68.0 |
| `pi.on('tool_result', event)` | `event.isError`, `event.toolName`, `event.input`, `event.content` | — |
| `pi.on('agent_end', event, ctx)` | `ctx.cwd` used to reset editedFiles | — |
| `pi.on('session_start', event, ctx)` | `ctx.cwd` used to set boundary | — |
| `pi.sendMessage(message, opts)` | `{ customType, content, display }` + `{ deliverAs, triggerTurn }` options | — |
| Tool result return `{ content }` | Must be `ContentBlock[]` matching pi's internal type | — |

`test/helpers/create-test-session.ts` and `e2e-tests/live.ts` are the version-sensitive
adapters. Both must be kept in sync — they share the same fragile API surfaces. When a new
pi minor breaks compat, these are the first places to look.

Cross-reference CHANGELOG.md when diagnosing failures against a new pi version.

---

## Invariants

1. **`shellQuote()` wraps all file paths** in `substitute.ts`. Never pass a raw file path
   into a shell command string. This is a security invariant — path injection via filenames
   with `$()` or spaces must be blocked.
2. **`tool_result` appends, never replaces.** Return `{ content: [...event.content, added] }`.
3. **`onEdit` is informational — never blocks.** Commands run, output is appended, but a
   non-zero exit does not stop the agent turn.
4. **`onStop` sends a follow-up for both infos and errors.** Zero-exit with no output produces no message; non-zero always triggers a new agent turn; zero-exit with output sends an informational follow-up without triggering a turn.
5. **`sendMessage` uses `deliverAs: 'followUp'`**, not a bare user message. Error paths additionally set `triggerTurn: true`.
6. **No build step, no dist/.** `src/*.ts` and `cli.mjs` are published as-is.
7. **`src/` files are pure.** No pi imports in `glob.ts`, `substitute.ts`, `types.ts`,
   `discover.ts`, `resolve.ts`, or `core.ts` — only `index.ts` imports `ExtensionAPI`.

---

## Tests

```
test-repos/verify.sh                    — fixture JSON validation + core logic (39 tests, no API)
e2e-tests/run.sh                        — security + behavior checks (12 tests, no API)
test/integration/mock-server.test.ts    — full pipeline via local HTTP mock (7 tests, no API)
test/integration/real-api.test.ts       — real Haiku calls, auto-skipped without key
e2e-tests/live.ts                       — live SDK sessions (5 tests, requires key)
scripts/test-compat.sh                  — compat matrix: last N pi minors (default: 3)
```

`mock-server.test.ts` is the primary integration signal and runs in the compat matrix.
`real-api.test.ts` and `live.ts` are for final verification.

API key lives in `.env` at the repo root (`ANTHROPIC_API_KEY=...`). The compat script does
not read `.env` automatically — export the key before running it.

For pi release validation, use the `pi-release-compat` skill.

---

## Publishing

`"files": ["src/", "cli.mjs", "README.md", "edit-hooks.example.json", "edit-hooks.path-keyed.example.json"]`

Version bumps: **patch** for bug fixes / compat shims; **minor** for new user-visible
behaviour; **major** for breaking changes to `.pi/edit-hooks.json` schema or CLI protocol.

CHANGELOG entries must reference the pi version that caused the change:
`createAgentSession tools option changed to string[] in pi 0.68.0`

---

## Commands

```bash
npm run test:verify                        # fixture + core logic (no API)
npm test                                   # bash e2e suite (no API)
npm run test:mock                          # mock-server vitest (no API)
npm run test:real                          # real Haiku API (requires ANTHROPIC_API_KEY)
npm run test:live                          # live SDK sessions (requires .env with key)
npm run test:all                           # verify + e2e + integration
npm run test:compat                        # compat matrix: last 3 pi minors (requires API key)
SKIP_E2E=1 bash scripts/test-compat.sh    # skip bash e2e, keep real-api + live
npm run typecheck                          # tsc --noEmit
npm run check                             # biome check src/
npm run pack:preview                       # npm pack --dry-run
```
