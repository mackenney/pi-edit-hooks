#!/usr/bin/env node
/**
 * format-check CLI — Claude Code compat (pure ESM, no TypeScript)
 *
 * Subcommands:
 *   accumulate  read stdin JSON {tool_input: {file_path}, session_id}, append to /tmp/agent-edits-{session_id}
 *   check       read stdin JSON {session_id, stop_hook_active}, run format/lint/typecheck on accumulated files
 */

import { exec as execCb } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execCb)

// ── Constants ──────────────────────────────────────────────────────────────────

const CONFIG_DIR = '.agent'
const CONFIG_FILE = 'tools.json'
const PROJECT_MARKERS = ['.git', 'pyproject.toml', 'package.json', 'Cargo.toml', 'go.mod']
const CHECKS_TIMEOUT_MS = 60_000

const DEFAULT_FORMAT = {
  '*.{py,pyi}': 'uv run ruff format --force-exclude {file}',
}
const DEFAULT_LINT = {
  '*.{py,pyi}': 'uv run ruff check --force-exclude --fix {file}',
}
const DEFAULT_TYPECHECK = {
  '*.py': 'uv run basedpyright {file}',
}

// ── Helpers ────────────────────────────────────────────────────────────────────

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

function loadConfig(configPath) {
  try {
    return JSON.parse(readFileSync(configPath, 'utf8'))
  } catch {
    return {}
  }
}

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

function findClosestPyprojectDir(filePath) {
  let dir = dirname(resolve(filePath))
  while (true) {
    if (existsSync(`${dir}/pyproject.toml`)) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function groupFilesByPyproject(files) {
  const groups = new Map()
  for (const file of files) {
    const dir = findClosestPyprojectDir(file) ?? findProjectRoot(file)
    const group = groups.get(dir) ?? []
    group.push(file)
    groups.set(dir, group)
  }
  return groups
}

function expandBraces(pattern) {
  const m = pattern.match(/^(.*)\{([^}]+)\}(.*)$/)
  if (!m) return [pattern]
  const [, pre, inner, post] = m
  return inner.split(',').map((part) => `${pre}${part}${post}`)
}

function matchesGlob(file, pattern) {
  const name = basename(file)
  const expansions = expandBraces(pattern)
  for (const p of expansions) {
    const regex = new RegExp(
      '^' + p.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$'
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

function substituteVars(cmd, file, projectRoot, configDir, allFiles) {
  const absFile = resolve(file)
  let result = cmd
  if (result.startsWith('./') || result.startsWith('../')) {
    result = `${configDir}/${result}`
  }
  result = result.replace(/\{file\}/g, `"${absFile}"`)
  result = result.replace(/\{projectRoot\}/g, `"${projectRoot}"`)
  const filesArgs = allFiles
    ? allFiles.map((f) => `"${resolve(f)}"`).join(' ')
    : `"${absFile}"`
  result = result.replace(/\{files\}/g, filesArgs)
  return result
}

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

function resolveSection(config, key, defaults) {
  if (config === null) return defaults
  const val = config[key]
  if (val === false) return null
  if (val && typeof val === 'object') return val
  return null
}

// ── Subcommands ────────────────────────────────────────────────────────────────

async function accumulate() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  const data = JSON.parse(raw)
  const filePath = data.tool_input?.file_path
  const sessionId = data.session_id
  if (!filePath || !sessionId) process.exit(0)
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

  const listFile = `/tmp/agent-edits-${sessionId}`
  if (!existsSync(listFile)) process.exit(0)

  // Read, deduplicate, and clear
  const content = readFileSync(listFile, 'utf8')
  writeFileSync(listFile, '', 'utf8')
  const files = [...new Set(content.split('\n').map(f => f.trim()).filter(Boolean))]

  if (files.length === 0) process.exit(0)

  const allErrors = []
  const liveFiles = files.filter((f) => existsSync(f))

  // Group by nearest pyproject.toml so each invocation uses the correct
  // workspace member as cwd — avoids wrong-project discovery with uv / basedpyright.
  const groups = groupFilesByPyproject(liveFiles)

  for (const [groupDir, groupFiles] of groups) {
    const found = findConfig(groupFiles[0])
    const config = found ? loadConfig(found.path) : null
    const configDir = found?.dir ?? groupDir
    const cwd = groupDir

    const formatGlobs = resolveSection(config, 'format', DEFAULT_FORMAT)
    const lintGlobs   = resolveSection(config, 'lint',   DEFAULT_LINT)
    const tcGlobs     = resolveSection(config, 'typecheck', DEFAULT_TYPECHECK)

    const sections = [
      [formatGlobs, false, 'format'],
      [lintGlobs,   true,  'lint'],
      [tcGlobs,     true,  'typecheck'],
    ]

    const groupErrors = []

    for (const [globs, fatal, label] of sections) {
      if (!globs) continue

      // Bucket files by matching command template
      const cmdToFiles = new Map()
      for (const file of groupFiles) {
        const rawCmd = findCommand(globs, file)
        if (!rawCmd) continue
        const bucket = cmdToFiles.get(rawCmd) ?? []
        bucket.push(file)
        cmdToFiles.set(rawCmd, bucket)
      }

      for (const [rawCmd, matchedFiles] of cmdToFiles) {
        if (rawCmd.includes('{files}')) {
          const cmd = substituteVars(rawCmd, matchedFiles[0], cwd, configDir, matchedFiles)
          const result = await runCommand(cmd, cwd, CHECKS_TIMEOUT_MS)
          if (fatal && result.failed) {
            const output = (result.stderr + result.stdout).trim()
            if (output) groupErrors.push(`[${label}] ${output}`)
          }
        } else {
          for (const file of matchedFiles) {
            const cmd = substituteVars(rawCmd, file, cwd, configDir)
            const result = await runCommand(cmd, cwd, CHECKS_TIMEOUT_MS)
            if (fatal && result.failed) {
              const output = (result.stderr + result.stdout).trim()
              if (output) groupErrors.push(`[${label}] ${output}`)
            }
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

// ── Entry ──────────────────────────────────────────────────────────────────────

const subcmd = process.argv[2]
if (subcmd === 'accumulate') {
  accumulate().catch((err) => { process.stderr.write(String(err) + '\n'); process.exit(1) })
} else if (subcmd === 'check') {
  check().catch((err) => { process.stderr.write(String(err) + '\n'); process.exit(1) })
} else {
  process.stderr.write(`Unknown subcommand: ${subcmd}\nUsage: cli.mjs accumulate|check\n`)
  process.exit(1)
}
