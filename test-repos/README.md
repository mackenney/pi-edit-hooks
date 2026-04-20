# Test Fixtures

Test fixtures for pi-edit-hooks verification.

## Running Tests

```bash
./verify.sh
```

## Fixtures

| Fixture | Purpose |
|---------|---------|
| `flat-config/` | Basic onEdit + onStop config |
| `path-keyed/` | Subdirectory scoping with `.` and `false` |
| `glob-patterns/` | Brace expansion and pattern matching |
| `workspace-grouping/` | Manifest-based file grouping |
| `variables/` | Variable substitution and relative paths |
| `disabled/` | Completely disabled hooks |

## What verify.sh Tests

1. **Config JSON validation** — all `edit-hooks.json` files parse without error
2. **Glob matching** — `*.py`, brace patterns `*.{ts,tsx}`, `*.{js,mjs,cjs}`, `*.json`
3. **Path-keyed resolution** — `.` fallback, explicit prefix match, `false` disable
4. **Variable substitution** — `{file}`, `{files}`, `{projectRoot}`, auto-append, relative paths
5. **Config discovery** — `findProjectConfig` locates `.pi/edit-hooks.json` by walking up
6. **Type guards** — `isPathKeyedConfig` distinguishes flat from path-keyed configs
7. **Normalize command** — string, array, false, empty string, empty array
