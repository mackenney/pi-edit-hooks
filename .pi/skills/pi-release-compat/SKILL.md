---
name: pi-release-compat
description: "Check compatibility of pi-edit-hooks against new @mariozechner/pi-coding-agent releases. Investigates what versions are new, runs the compat matrix, diagnoses any failures, and prepares commits. Stops for human review before implementing any fixes. Trigger phrases: check pi release, new pi version, compat check, test against new pi, pi compatibility, update pi dependency."
---

# pi-release-compat

Workflow for validating pi-edit-hooks against new `@mariozechner/pi-coding-agent` releases.

**Phases:**
1. [Investigate](#phase-1-investigate) — what versions exist, what is new, what changed
2. [Verify](#phase-2-verify) — run the compat matrix
3. [Act (green path)](#phase-3-act-green) — prepare a dependency bump commit
4. [Act (red path)](#phase-4-act-red) — diagnose, pause for human, implement fix, release

Do not skip phases. Investigation always comes before action.

---

## Phase 1: Investigate

### 1.1 Resolve current pinned version

```bash
node -e "console.log(require('./node_modules/@mariozechner/pi-coding-agent/package.json').version)"
```

### 1.2 Fetch published versions from npm

```bash
node -e "
const { execSync } = require('child_process');
const raw = execSync('npm show @mariozechner/pi-coding-agent versions --json').toString();
const all = JSON.parse(raw);
const byMinor = {};
all.forEach(v => {
  const [maj, min] = v.split('.');
  const key = maj + '.' + min;
  byMinor[key] = v;
});
const series = Object.entries(byMinor);
console.log('All minor series (latest patch per minor):');
series.forEach(([k, v]) => console.log(' ', k, '->', v));
console.log('\nLast 5:', series.slice(-5).map(([,v]) => v).join(', '));
"
```

### 1.3 Identify what is new

Compare to the currently pinned version. Note:
- Any minor series with a newer latest-patch than what is pinned
- Any entirely new minor series

### 1.4 Check the pi changelog for breaking changes

For each new minor version, look for changes to:
- `ExtensionAPI` event names or payload shapes (`tool_result`, `agent_end`, `session_start`)
- `createAgentSession` options (past example: `tools` changed from `Tool[]` to `string[]` in 0.68.0)
- `sendUserMessage` signature or `deliverAs` option
- Tool result return shape
- Any removed exports

Check the npm page or GitHub releases:

```bash
npm show @mariozechner/pi-coding-agent@<VERSION> changelog 2>/dev/null || true
```

The primary adapter between pi versions is `test/helpers/create-test-session.ts`.
Read it to understand what version-sensitive handling already exists before hypothesising
about new breakages.

### 1.5 Document findings before proceeding

Write a brief inline summary covering:
- Currently pinned version
- New version(s) detected
- Any API changes found in changelogs
- Hypothesis: likely green / possible breakage (and in which file/surface)

---

## Phase 2: Verify

### 2.1 Resolve the API key

The compat matrix runs real-api and live SDK tests, so an API key is required.
Read it from the repo's `.env`:

```bash
export ANTHROPIC_API_KEY=$(grep ANTHROPIC_API_KEY .env | cut -d= -f2)
```

### 2.2 Run the compat matrix

By default, tests the last 3 minor versions:

```bash
bash scripts/test-compat.sh 3
```

If more than one new minor series was detected in Phase 1, increase the count so all
new versions are covered:

```bash
bash scripts/test-compat.sh <N>
```

The script:
- Fetches the latest patch for each of the last N minor versions from npm
- Installs each with `--no-save` (does not touch `package.json`)
- Runs: bash e2e → mock-server vitest → real-api vitest → live SDK sessions
- Restores the original lockfile via `npm ci` at exit

Set `SKIP_E2E=1` to skip only the bash e2e suite (real-api and live still run):

```bash
SKIP_E2E=1 bash scripts/test-compat.sh 3
```

### 2.3 Capture full output

Keep the complete terminal output — you will need it for diagnosis if any version fails.

---

## Phase 3: Act (green path)

All versions passed. Proceed.

### 3.1 Update the lockfile to the latest version

The devDependency is `"*"` so `npm update` resolves to latest:

```bash
npm update @mariozechner/pi-coding-agent
```

Verify the lockfile changed and confirm the resolved version:

```bash
git diff package-lock.json | grep '"version"' | head -10
node -e "console.log(require('./node_modules/@mariozechner/pi-coding-agent/package.json').version)"
```

### 3.2 Run the full test suite one final time

```bash
npm run test:all
```

All tests must pass (verify + e2e + mock-server vitest).

Optionally run real-api and live suites for extra confidence:

```bash
ANTHROPIC_API_KEY=$(grep ANTHROPIC_API_KEY .env | cut -d= -f2) npm run test:real
node --env-file .env --experimental-strip-types e2e-tests/live.ts
```

### 3.3 Prepare the commit

```bash
git add package-lock.json
git commit -m "chore: update @mariozechner/pi-coding-agent to <NEW_VERSION>"
```

Report the commit hash and the versions covered. Do not push — the user decides when
to push and publish.

---

## Phase 4: Act (red path)

One or more versions failed. Do not implement anything yet.

### 4.1 Diagnose the failure

From the captured compat output, identify:
- Which pi version(s) failed
- Which test file(s) failed (bash e2e vs mock-server vitest)
- The exact error message

Common failure patterns (from history):

| Symptom | Likely cause |
|---|---|
| `AssertionError: expected 'Tool write not found' to contain ...` | `createAgentSession({ tools })` API changed — check `test/helpers/create-test-session.ts` and `e2e-tests/live.ts` |
| `The "path" argument must be of type string. Received undefined` | `DefaultResourceLoader({ agentDir })` became required — check both test helpers and `e2e-tests/live.ts` |
| `Cannot find module` / missing export | A pi export was removed or renamed |
| `AssertionError` on tool result content | `tool_result` event payload shape changed (`event.content`, `event.input`, `event.toolName`) |
| Follow-up message never arrives (onStop test times out) | `sendUserMessage` signature or `deliverAs` changed, or `agent_end` event name changed |
| Bash e2e fails on a specific check | Non-API change: glob, substitute, or resolve logic interacting with a new pi behavior |

To get more detail from a specific failing version without the compat script overhead:

```bash
npm install @mariozechner/pi-coding-agent@<VERSION> --no-save --legacy-peer-deps --silent
npx vitest run test/integration/mock-server.test.ts --reporter=verbose 2>&1 | tail -60
bash e2e-tests/run.sh 2>&1
# Restore:
npm ci --silent
```

The version-sensitive adapter is `test/helpers/create-test-session.ts`. Read it carefully
alongside `src/index.ts` before concluding what needs to change.

### 4.2 Identify the fix scope

Determine which files need changing:
- `src/index.ts` — extension logic uses a renamed/reshaped API
- `test/helpers/create-test-session.ts` — test session setup uses a changed SDK option
- `test/integration/mock-server.test.ts` — test assertions need updating

State the exact lines/functions that need to change and why.

### 4.3 STOP — present findings to the human

Do not implement anything. Present:

```
## Compat failure: pi@<VERSION>

**Failing tests:** <list>

**Root cause:** <precise statement — e.g., "createAgentSession tools option changed
from Tool[] to string[] in 0.68.0; passing [createWriteTool(cwd)] gives [object Object]
as the tool name, so write is never found">

**Evidence:**
- <error line from compat output>
- <relevant pi source or changelog reference>

**Proposed fix:**
- test/helpers/create-test-session.ts: <describe change>
- src/index.ts (if needed): <describe change>

**Fix scope:** patch-level bump (0.1.X)

Proceed with fix?
```

Wait for explicit confirmation before continuing.

### 4.4 Implement the fix (after human approval)

Apply the minimal change required. Follow the invariants in AGENTS.md:
- `shellQuote()` must wrap all file paths — never remove this
- `tool_result` returns `{ content: [...event.content, added] }` — never replace
- `onEdit` is informational and never blocks
- `onStop` only messages on non-zero exit, using `deliverAs: 'followUp'`
- No build step, no dist/, no new devDependencies without reason

After editing:

```bash
npm run typecheck
npm run test:mock
bash e2e-tests/run.sh
```

All must pass before continuing.

### 4.5 Run the full compat matrix again

```bash
bash scripts/test-compat.sh 3
```

Every version in the matrix must be green. If a previously passing version now fails
(regression), treat it as a new failure and return to 4.1.

### 4.6 Update CHANGELOG.md

Add an entry under a new version header, referencing the pi version:

```markdown
## [0.1.X] - YYYY-MM-DD

### Fixed
- <Description of what broke and the fix> (pi@<VERSION>)
```

### 4.7 Bump the package version

Edit `package.json`:
- **Patch** (0.1.X): compat shims, test-only fixes, guards for renamed APIs
- **Minor** (0.X.0): new user-visible behaviour added as part of the fix

### 4.8 Prepare the release commit

```bash
npm run test:all                         # full suite, final check
npm run pack:preview                     # confirm published files
npm update @mariozechner/pi-coding-agent # update lockfile
git add src/ test/ CHANGELOG.md package.json package-lock.json
git commit -m "fix: <short description> (pi@<VERSION>)"
```

Report the commit hash, changed files, and new version. Do not push or `npm publish` —
that is the user's call.

---

## Quick reference

```bash
# Current pinned version
node -e "console.log(require('./node_modules/@mariozechner/pi-coding-agent/package.json').version)"

# Latest patch per minor series (last 5)
npm show @mariozechner/pi-coding-agent versions --json | \
  node -e "const a=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); \
  const m={}; a.forEach(v=>{const[x,y]=v.split('.');m[x+'.'+y]=v;}); \
  console.log(Object.values(m).slice(-5).join(', '))"

# Run compat matrix (last 3 minors, requires API key)
export ANTHROPIC_API_KEY=$(grep ANTHROPIC_API_KEY .env | cut -d= -f2)
bash scripts/test-compat.sh 3

# Run compat matrix (skip bash e2e, keep real-api + live)
SKIP_E2E=1 bash scripts/test-compat.sh 3

# Full test suite
npm run test:all

# Real API tests
ANTHROPIC_API_KEY=$(grep ANTHROPIC_API_KEY .env | cut -d= -f2) npm run test:real

# Live SDK sessions
node --env-file .env --experimental-strip-types e2e-tests/live.ts

# Update lockfile to latest
npm update @mariozechner/pi-coding-agent
```
