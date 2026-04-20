#!/usr/bin/env node
/**
 * pi-edit-hooks CLI — Claude Code compat (pure ESM, no TypeScript)
 *
 * Subcommands:
 *   accumulate  read stdin JSON {tool_input: {file_path}, session_id}, append to /tmp/agent-edits-{session_id}
 *   check       read stdin JSON {session_id, stop_hook_active}, run onStop hooks on accumulated files
 */

import { exec as execCb } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execCb)

const CONFIG_DIR = '.pi'
const CONFIG_FILE = 'edit-hooks.json'
const PROJECT_MARKERS = ['.git', 'pyproject.toml', 'package.json', 'Cargo.toml', 'go.mod']
const CHECKS_TIMEOUT_MS = 60_000

const GLOBAL_CONFIG_PATH = join(homedir(), '.pi', 'agent', CONFIG_FILE)
const GLOBAL_CONFIG_DIR = join(homedir(), '.pi', 'agent')

// Maps file extensions to the manifest that anchors their workspace —
// matches core.ts so the CLI uses the same cwd as the extension.
const EXTENSION_MANIFEST = {
  '.py':  'pyproject.toml',
  '.pyi': 'pyproject.toml',
  '.ts':  'package.json',
  '.tsx': 'package.json',
  '.js':  'package.json',
  '.jsx': 'package.json',
  '.mjs': 'package.json',
  '.cjs': 'package.json',
  '.rs':  'Cargo.toml',
  '.go':  'go.mod',
}

// ── Shell quoting ─────────────────────────────────────────────────────────────

/**
 * Shell-quote a string using POSIX single-quote wrapping.
 * Safe against $, `, !, spaces, \ and any other special characters in filenames.
 */
function shellQuote(s) {
  return `'${s.replace(/'/g, "'\\''")}'`
}

// ── Config discovery ──────────────────────────────────────────────────────────

function findConfig(filePath) {
  let dir = dirname(resolve(filePath))
  while (true) {
    const candidate = `${dir}/${CONFIG_DIR}/${CONFIG_FILE}`
    if (existsSync(candidate)) {
      return { path: candidate, dir }
    }
    // Stop only at .git, not at pyproject.toml/package.json — those appear at
    // every member level in monorepos and must not hide the root config.
    if (existsSync(`${dir}/.git`)) return null
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function findConfigWithGlobalFallback(filePath) {
  const local = findConfig(filePath)
  if (local) return local
  if (existsSync(GLOBAL_CONFIG_PATH)) {
    return { path: GLOBAL_CONFIG_PATH, dir: GLOBAL_CONFIG_DIR }
  }
  return null
}

function loadConfig(configPath) {
  try {
    return JSON.parse(readFileSync(configPath, 'utf8'))
  } catch {
    return {}
  }
}

// ── Project / manifest helpers ────────────────────────────────────────────────

function findProjectRoot(filePath) {
  let dir = dirname(resolve(filePath))
  while (true) {
    for (const marker of PROJECT_MARKERS) {
      if (existsSync(`${dir}/${marker}`)) return dir
    }
    const parent = dirname(dir)
    if (parent === dir) return dirname(resolve(filePath))
    dir = parent
  }
}

function findClosestManifestDir(filePath, manifest) {
  let dir = dirname(resolve(filePath))
  while (true) {
    if (existsSync(join(dir, manifest))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Group files by the directory of their nearest workspace manifest.
 * Mirrors core.ts groupFilesByManifest so the CLI uses the same cwd as the
 * extension for every file type (Python, TypeScript, Rust, Go…).
 * An optional workspace override in the config takes precedence over
 * the default extension-to-manifest mapping.
 */
function groupFilesByManifest(files, config) {
  const ws = config?.workspace
  const groups = new Map()
  for (const file of files) {
    let manifest
    if (ws === false) {
      manifest = null
    } else if (typeof ws === 'string') {
      manifest = ws
    } else if (ws && typeof ws === 'object') {
      manifest = findCommand(ws, file) ?? null
    } else {
      manifest = EXTENSION_MANIFEST[extname(file)] ?? null
    }
    const dir = (manifest ? findClosestManifestDir(file, manifest) : null) ?? findProjectRoot(file)
    const group = groups.get(dir) ?? []
    group.push(file)
    groups.set(dir, group)
  }
  return groups
}

// ── Glob matching ─────────────────────────────────────────────────────────────

/**
 * Expand all brace groups recursively.
 * Uses non-greedy match so multiple groups are handled correctly:
 * "{a,b}.{c,d}" → ["a.c", "a.d", "b.c", "b.d"]
 */
function expandBraces(pattern) {
  const m = pattern.match(/^(.*?)\{([^}]+)\}(.*)$/)
  if (!m) return [pattern]
  const [, pre, inner, post] = m
  return inner.split(',').flatMap(part => expandBraces(`${pre}${part}${post}`))
}

function matchesGlob(file, pattern) {
  const name = basename(file)
  const expansions = expandBraces(pattern)
  for (const p of expansions) {
    const regex = new RegExp(
      '^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'
    )
    if (regex.test(name)) return true
  }
  return false
}

function findCommand(globs, file) {
  for (const [pattern, cmd] of Object.entries(globs)) {
    if (matchesGlob(file, pattern)) return cmd
  }
  return null
}

// ── Config resolution ─────────────────────────────────────────────────────────

function isPathKeyed(config) {
  return Object.keys(config).some(key => key === '.' || key.includes('/'))
}

function resolvePathKeyedSection(config, filePath, configDir) {
  const absFile = resolve(filePath)
  const absConfigDir = resolve(configDir)
  // Use proper relative path (same logic as resolve.ts)
  const relParts = absFile.startsWith(absConfigDir + '/')
    ? absFile.slice(absConfigDir.length + 1)
    : null

  if (!relParts) return null

  const matches = []
  for (const [key, section] of Object.entries(config)) {
    if (key === '.') {
      matches.push({ key, length: 0, section })
    } else {
      const normalizedKey = key.replace(/\/$/, '')
      if (relParts === normalizedKey || relParts.startsWith(normalizedKey + '/')) {
        matches.push({ key, length: normalizedKey.length, section })
      }
    }
  }

  if (matches.length === 0) return null
  matches.sort((a, b) => b.length - a.length)
  return matches[0].section
}

function resolveOnStopSection(config, filePath, configDir) {
  if (config === null) return null

  let flatConfig = config
  if (isPathKeyed(config)) {
    const section = resolvePathKeyedSection(config, filePath, configDir)
    if (section === false) return null
    flatConfig = section
  }

  if (!flatConfig) return null

  const val = flatConfig.onStop
  if (val === false) return null
  if (val && typeof val === 'object') return val
  return null
}

// ── Variable substitution ─────────────────────────────────────────────────────

function substituteVars(cmd, file, projectRoot, configDir, allFiles) {
  const absFile = resolve(file)
  let result = cmd

  if (result.startsWith('./') || result.startsWith('../')) {
    const spaceIdx = result.indexOf(' ')
    const rel = spaceIdx === -1 ? result : result.slice(0, spaceIdx)
    const rest = spaceIdx === -1 ? '' : result.slice(spaceIdx)
    result = shellQuote(join(configDir, rel)) + rest
  }

  // Auto-append {files} if no placeholder present (onStop mode)
  const hasPlaceholder = result.includes('{file}') || result.includes('{files}')
  if (!hasPlaceholder) {
    result = result + ' {files}'
  }

  result = result.replace(/\{file\}/g, shellQuote(absFile))
  // Capture path suffix so {projectRoot}/mypy.ini → '/root/mypy.ini' not '/root'/mypy.ini
  result = result.replace(/\{projectRoot\}([^\s]*)/g, (_, suffix) =>
    shellQuote(projectRoot + suffix),
  )
  const filesArgs = allFiles
    ? allFiles.map(f => shellQuote(resolve(f))).join(' ')
    : shellQuote(absFile)
  result = result.replace(/\{files\}/g, filesArgs)
  return result
}

// ── Command runner ────────────────────────────────────────────────────────────

async function runCommand(cmd, cwd, timeoutMs) {
  try {
    const { stdout, stderr } = await exec(cmd, { cwd, timeout: timeoutMs })
    return { stdout: stdout ?? '', stderr: stderr ?? '', failed: false }
  } catch (err) {
    return {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      failed: true,
    }
  }
}

// ── Subcommands ───────────────────────────────────────────────────────────────

async function accumulate() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  const data = JSON.parse(raw)
  const filePath = data.tool_input?.file_path
  const sessionId = data.session_id
  if (!filePath || !sessionId) process.exit(0)

  // Validate session_id to prevent path traversal via /tmp/agent-edits-<id>
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    process.stderr.write(`[pi-edit-hooks] Invalid session_id: ${sessionId}\n`)
    process.exit(0)
  }

  const listFile = `/tmp/agent-edits-${sessionId}`
  appendFileSync(listFile, filePath + '\n', 'utf8')
  process.exit(0)
}

async function check() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  const data = JSON.parse(raw)
  const { session_id: sessionId, stop_hook_active: stopHookActive } = data

  // Loop guard
  if (stopHookActive === true) process.exit(0)

  // Validate session_id to prevent path traversal
  if (!sessionId || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    process.stderr.write(`[pi-edit-hooks] Invalid session_id\n`)
    process.exit(0)
  }

  const listFile = `/tmp/agent-edits-${sessionId}`
  if (!existsSync(listFile)) process.exit(0)

  // Read, deduplicate, and clear
  const content = readFileSync(listFile, 'utf8')
  writeFileSync(listFile, '', 'utf8')
  const files = [...new Set(content.split('\n').map(f => f.trim()).filter(Boolean))]

  if (files.length === 0) process.exit(0)

  const allErrors = []
  const liveFiles = files.filter(f => existsSync(f))

  // Group by nearest workspace manifest (matches index.ts grouping logic)
  const firstFound = findConfigWithGlobalFallback(liveFiles[0])
  const firstConfig = firstFound ? loadConfig(firstFound.path) : null
  const groups = groupFilesByManifest(liveFiles, firstConfig)

  for (const [groupDir, groupFiles] of groups) {
    const found = findConfigWithGlobalFallback(groupFiles[0])
    if (!found) continue  // No config = no checks

    const config = loadConfig(found.path)
    const configDir = found.dir
    const cwd = groupDir

    const onStopGlobs = resolveOnStopSection(config, groupFiles[0], configDir)
    if (!onStopGlobs) continue  // onStop disabled or not defined

    const groupErrors = []

    // Bucket files by matching command template
    const cmdToFiles = new Map()
    for (const file of groupFiles) {
      const rawCmd = findCommand(onStopGlobs, file)
      if (!rawCmd) continue
      const bucket = cmdToFiles.get(rawCmd) ?? []
      bucket.push(file)
      cmdToFiles.set(rawCmd, bucket)
    }

    for (const [rawCmd, matchedFiles] of cmdToFiles) {
      const usesBatch = rawCmd.includes('{files}') ||
                        (!rawCmd.includes('{file}') && !rawCmd.includes('{files}'))

      if (usesBatch) {
        const cmd = substituteVars(rawCmd, matchedFiles[0], cwd, configDir, matchedFiles)
        const result = await runCommand(cmd, cwd, CHECKS_TIMEOUT_MS)
        if (result.failed) {
          const output = (result.stderr + result.stdout).trim()
          if (output) groupErrors.push(`[onStop] ${output}`)
        }
      } else {
        for (const file of matchedFiles) {
          const cmd = substituteVars(rawCmd, file, cwd, configDir)
          const result = await runCommand(cmd, cwd, CHECKS_TIMEOUT_MS)
          if (result.failed) {
            const output = (result.stderr + result.stdout).trim()
            if (output) groupErrors.push(`[onStop] ${output}`)
          }
        }
      }
    }

    if (groupErrors.length > 0) {
      allErrors.push(`${groupDir}\n${groupErrors.join('\n')}`)
    }
  }

  if (allErrors.length > 0) {
    process.stderr.write(
      `Checks failed after edits:\n\n${allErrors.join('\n\n')}\n`
    )
    process.exit(2)
  }

  process.exit(0)
}

// ── Entry ─────────────────────────────────────────────────────────────────────

const subcmd = process.argv[2]
if (subcmd === 'accumulate') {
  accumulate().catch(err => { process.stderr.write(String(err) + '\n'); process.exit(1) })
} else if (subcmd === 'check') {
  check().catch(err => { process.stderr.write(String(err) + '\n'); process.exit(1) })
} else {
  process.stderr.write(`Unknown subcommand: ${subcmd}\nUsage: cli.mjs accumulate|check\n`)
  process.exit(1)
}
