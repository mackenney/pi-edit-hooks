# pi-edit-hooks Redesign

## Objective

Redesign `format-check` into `pi-edit-hooks` with:
- Two hooks: `onEdit` (informational per-file) and `onStop` (fatal at agent end)
- Config files: `~/.pi/agent/edit-hooks.json` (global), `.pi/edit-hooks.json` (project)
- Path-keyed configs for subdirectory scoping
- Workspace grouping via nearest manifest for `{files}` batching
- No hardcoded defaults — no config = no checks

## Wave Map

| Wave | Steps | Parallelizable | Depends On |
|------|-------|----------------|------------|
| 1 | 01, 02, 03 | Yes (all independent) | — |
| 2 | 04, 05 | No (sequential) | Wave 1 |
| 3 | 06, 07 | Yes (independent) | Wave 2 |
| 4 | 08, 09 | Yes (independent) | Wave 3 |
| 5 | 10 | — | Wave 4 |

## Steps

- [ ] [step-01-types](./step-01-types.md) — Define TypeScript interfaces for config schema
- [ ] [step-02-glob](./step-02-glob.md) — Improve glob matching with better regex escaping
- [ ] [step-03-substitute](./step-03-substitute.md) — Variable substitution with auto-append
- [ ] [step-04-discovery](./step-04-discovery.md) — Config parsing and boundary-aware discovery
- [ ] [step-05-resolution](./step-05-resolution.md) — Path-keyed resolution and section merging
- [ ] [step-06-pi-wiring](./step-06-pi-wiring.md) — Pi extension event handlers with session state
- [ ] [step-07-cli](./step-07-cli.md) — CLI migration to onEdit/onStop schema
- [ ] [step-08-package](./step-08-package.md) — package.json and example config
- [ ] [step-09-tests](./step-09-tests.md) — Test fixtures and verify.sh
- [ ] [step-10-npm-publish](./step-10-npm-publish.md) — npm publish setup: correct pi.extensions, peerDeps, publishConfig, README

## Architecture Overview

```
pi-edit-hooks/
├── types.ts          # Config type definitions
├── glob.ts           # Glob matching (hand-rolled, no deps)
├── substitute.ts     # Variable substitution with auto-append
├── discover.ts       # Config discovery with git boundary
├── resolve.ts        # Path-keyed resolution + merge
├── core.ts           # Orchestration: resolveConfig, runHook
├── index.ts          # Pi extension entry point
├── cli.mjs           # Claude Code CLI compatibility
├── package.json
├── edit-hooks.example.json
└── test-repos/
    ├── verify.sh
    └── ...fixtures...
```

## Key Design Decisions

### Config Merge Semantics
- Global config provides base sections
- Project config (after path-key resolution) replaces entire sections
- Path-keyed match disables access to root "." section (no fallback merge)

### onEdit vs onStop
- **onEdit**: Runs per-file on tool_result, appends output, never blocks
- **onStop**: Runs at agent_end, groups files by manifest, uses sendUserMessage followUp on failure

### Variables
- `{file}` — absolute path of edited file
- `{files}` — space-separated absolute paths (onStop only)
- `{projectRoot}` — directory containing config file
- Auto-append: commands without `{file}`/`{files}` get the appropriate variable added

### Glob Matching
- Hand-rolled (no micromatch dependency)
- Basename only, brace expansion, first match wins
- No `**` support (path-keyed configs handle subdirectory scoping)
