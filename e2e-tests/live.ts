/**
 * Real E2E tests for pi-edit-hooks using the pi SDK.
 *
 * Spins up actual agent sessions with the extension loaded, has the agent
 * write files, and asserts that onEdit / onStop hooks fire correctly.
 *
 * Usage:
 *   node --experimental-strip-types e2e-tests/live.ts
 *
 * Timing note:
 *   session.prompt() returns after the agent's direct turn completes, but the
 *   extension's agent_end handler is async and fires AFTER prompt() resolves.
 *   For tests that expect a follow-up (onStop failure), we poll until the
 *   follow-up user message appears in the conversation or a timeout is reached.
 */

import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
  createAgentSession,
  createCodingTools,
  type AgentSession,
} from '@mariozechner/pi-coding-agent'
import { getModel } from '@mariozechner/pi-ai'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const EXTENSION_PATH = '/home/ignacio/pr/pi-edit-hooks/index.ts'
const MODEL_ID = 'claude-haiku-4-5'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeProject(config: object): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'pi-edit-hooks-live-'))
  mkdirSync(join(dir, '.pi'))
  writeFileSync(join(dir, '.pi', 'edit-hooks.json'), JSON.stringify(config, null, 2))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function makeAuthStorage(): typeof AuthStorage.prototype {
  const envKey = process.env.ANTHROPIC_API_KEY
  if (envKey) {
    return AuthStorage.inMemory({ anthropic: { type: 'api_key', key: envKey } })
  }
  return AuthStorage.create()
}

async function makeSession(cwd: string) {
  const authStorage = makeAuthStorage()
  const modelRegistry = ModelRegistry.create(authStorage)
  const model = getModel('anthropic', MODEL_ID)
  if (!model) throw new Error(`Model ${MODEL_ID} not found`)

  const loader = new DefaultResourceLoader({
    cwd,
    additionalExtensionPaths: [EXTENSION_PATH],
    systemPromptOverride: () =>
      'You are a test assistant. When asked to write a file, call the write tool ' +
      'exactly once with the requested content, then stop. Do not explain, do not ' +
      'retry, do not attempt to fix errors reported in tool results.',
  })
  await loader.reload()

  const { session } = await createAgentSession({
    cwd,
    model,
    thinkingLevel: 'off',
    authStorage,
    modelRegistry,
    resourceLoader: loader,
    tools: createCodingTools(cwd),
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
  })

  return session
}

/** Serialize all session messages to a searchable string. */
function allText(session: AgentSession): string {
  return JSON.stringify(session.agent.state.messages)
}

/**
 * After session.prompt() returns, the extension's agent_end handler is still
 * running asynchronously (it execs shell commands before queuing follow-ups).
 * Poll until the predicate is satisfied or the timeout expires.
 */
async function waitFor(
  session: AgentSession,
  predicate: (text: string) => boolean,
  timeoutMs = 10_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate(allText(session))) return true
    await new Promise(r => setTimeout(r, 300))
  }
  return false
}

// ── Test runner ───────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`  ${name} … `)
  try {
    await fn()
    console.log('\x1b[32m✓\x1b[0m')
    passed++
  } catch (err: unknown) {
    console.log('\x1b[31m✗\x1b[0m')
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`    ${msg}`)
    failed++
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log('\n=== Live E2E Tests (real agent sessions) ===\n')

// ── 1. onEdit output appears inline in the tool result ────────────────────────
await test('onEdit: output appended to tool result', async () => {
  const { dir, cleanup } = makeProject({
    onEdit: { '*.py': 'echo EDIT_HOOK_FIRED' },
  })
  try {
    const session = await makeSession(dir)
    await session.prompt(`Write the file ${join(dir, 'test.py')} with content: x = 1`)
    const text = allText(session)
    if (!text.includes('EDIT_HOOK_FIRED')) {
      throw new Error('onEdit output "EDIT_HOOK_FIRED" not found in session messages')
    }
    if (!text.includes('⚠ onEdit:')) {
      throw new Error('onEdit prefix "⚠ onEdit:" not found in session messages')
    }
  } finally {
    cleanup()
  }
})

// ── 2. onStop passes silently — no follow-up sent ─────────────────────────────
await test('onStop: passes silently when command exits 0', async () => {
  const { dir, cleanup } = makeProject({
    onStop: { '*.py': 'echo ALL_GOOD' },
  })
  try {
    const session = await makeSession(dir)
    await session.prompt(`Write the file ${join(dir, 'check.py')} with content: y = 2`)

    // Give the extension's agent_end handler time to run (it would send
    // a follow-up if it found errors — we want to confirm it doesn't).
    await new Promise(r => setTimeout(r, 3_000))

    const text = allText(session)
    if (text.includes('Checks failed after edits')) {
      throw new Error('Unexpected "Checks failed" follow-up — onStop should have passed silently')
    }
  } finally {
    cleanup()
  }
})

// ── 3. onStop failure triggers a follow-up message ───────────────────────────
await test('onStop: failure sends follow-up with error output', async () => {
  const { dir, cleanup } = makeProject({
    onStop: { '*.py': "bash -c 'echo STOP_HOOK_ERROR >&2; exit 1'" },
  })
  try {
    const session = await makeSession(dir)
    await session.prompt(`Write the file ${join(dir, 'bad.py')} with content: z = 3`)

    // Poll: extension's agent_end fires async after prompt() returns, then
    // executes the shell command, then queues the follow-up user message.
    const found = await waitFor(session, t => t.includes('Checks failed after edits'))
    if (!found) {
      throw new Error(
        'Timed out waiting for "Checks failed after edits" follow-up.\n' +
        `Messages: ${allText(session).slice(0, 600)}`,
      )
    }
    if (!allText(session).includes('STOP_HOOK_ERROR')) {
      throw new Error('Hook error output "STOP_HOOK_ERROR" missing from follow-up message')
    }
  } finally {
    cleanup()
  }
})

// ── 4. onEdit with array commands — every step runs ──────────────────────────
await test('onEdit: array command runs each step in sequence', async () => {
  const { dir, cleanup } = makeProject({
    onEdit: { '*.py': ['echo STEP_ONE', 'echo STEP_TWO'] },
  })
  try {
    const session = await makeSession(dir)
    await session.prompt(`Write the file ${join(dir, 'steps.py')} with content: a = 1`)
    const text = allText(session)
    if (!text.includes('STEP_ONE')) {
      throw new Error('"STEP_ONE" not found — first command in array did not run')
    }
    if (!text.includes('STEP_TWO')) {
      throw new Error('"STEP_TWO" not found — second command in array did not run')
    }
  } finally {
    cleanup()
  }
})

// ── 5. path-keyed config — disabled subtree produces no hook output ───────────
await test('path-keyed: false disables hooks for subtree', async () => {
  const { dir, cleanup } = makeProject({
    '.': { onEdit: { '*.py': 'echo ROOT_HOOK' } },
    'legacy/': false,
  })
  try {
    mkdirSync(join(dir, 'legacy'))
    const session = await makeSession(dir)
    await session.prompt(
      `Write the file ${join(dir, 'legacy', 'old.py')} with content: old = True`,
    )
    const text = allText(session)
    if (text.includes('ROOT_HOOK')) {
      throw new Error('"ROOT_HOOK" fired — hooks should be disabled for legacy/ subtree')
    }
  } finally {
    cleanup()
  }
})

// ── Results ───────────────────────────────────────────────────────────────────

console.log('')
console.log('════════════════════════════════════════════════')
console.log(
  `Results: \x1b[32m${passed} passed\x1b[0m, ` +
  `${failed > 0 ? '\x1b[31m' : '\x1b[32m'}${failed} failed\x1b[0m`,
)

if (failed > 0) process.exit(1)
