import { exec as execCb } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { promisify } from 'node:util'


const exec = promisify(execCb)

// ── Constants ─────────────────────────────────────────────────────────────────

export const CONFIG_DIR = '.agent'
export const CONFIG_FILE = 'tools.json'
export const PROJECT_MARKERS = ['.git', 'pyproject.toml', 'package.json', 'Cargo.toml', 'go.mod']

// Config discovery walks through intermediate pyproject.toml / package.json
// files (which appear at every member level in monorepos) and only stops at
// .git — the true repository boundary.
export const CONFIG_BOUNDARY_MARKER = '.git'
export const SYNTAX_TIMEOUT_MS = 5_000
export const CHECKS_TIMEOUT_MS = 60_000

// ── Default tier 1 ────────────────────────────────────────────────────────────

export const DEFAULT_SYNTAX: Record<string, string> = {
  '*.py':            "python3 -c 'import ast,sys;ast.parse(open(sys.argv[1]).read(),sys.argv[1])' {file}",
  '*.pyi':           "python3 -c 'import ast,sys;ast.parse(open(sys.argv[1]).read(),sys.argv[1])' {file}",
  '*.{js,mjs,cjs}':  'node --check {file}',
  '*.{ts,tsx}':      'node --check {file}',
  '*.{sh,bash}':     'bash -n {file}',
  '*.json':          'python3 -m json.tool {file} >/dev/null',
  '*.go':            'gofmt -e {file} >/dev/null',
  '*.rs':            'rustfmt --emit=stdout {file} >/dev/null',
}

// ── Default tier 2 (no config found) ─────────────────────────────────────────

export const DEFAULT_FORMAT: Record<string, string> = {
  '*.{py,pyi}': 'uv run ruff format --force-exclude {file}',
}
export const DEFAULT_LINT: Record<string, string> = {
  '*.{py,pyi}': 'uv run ruff check --force-exclude --fix {file}',
}
export const DEFAULT_TYPECHECK: Record<string, string> = {
  '*.py': 'ty check {file}',
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ToolsConfig {
  syntax?:    Record<string, string> | false
  format?:    Record<string, string> | false
  lint?:      Record<string, string> | false
  typecheck?: Record<string, string> | false
  // Controls which manifest file anchors the workspace grouping for cwd routing.
  // string: use this manifest for all files in the repo (e.g. "Cargo.toml")
  // Record: per-glob override (e.g. { "*.py": "pyproject.toml", "*.ts": "package.json" })
  // false: disable grouping entirely — always use project root as cwd
  // absent: auto-detect from file extension
  workspace?: string | Record<string, string> | false
}

export interface FindConfigResult {
  path: string  // absolute path to tools.json
  dir: string   // directory containing .agent/ (i.e. parent of .agent/)
}

export interface RunResult {
  stdout: string
  stderr: string
  failed: boolean
}

// ── Config discovery ──────────────────────────────────────────────────────────

// Global fallback: ~/.pi/agent/tools.json
// Relative command paths (./scripts/...) in the global config resolve against this dir.
const GLOBAL_FALLBACK_DIR = join(homedir(), '.pi', 'agent')
const GLOBAL_FALLBACK_CONFIG = join(GLOBAL_FALLBACK_DIR, CONFIG_FILE)

export function findConfig(filePath: string): FindConfigResult | null {
  let dir = dirname(resolve(filePath))
  while (true) {
    // 1. Check for .agent/tools.json
    const candidate = `${dir}/${CONFIG_DIR}/${CONFIG_FILE}`
    if (existsSync(candidate)) {
      return { path: candidate, dir }
    }
    // 2. Stop at the git root — but NOT at pyproject.toml / package.json,
    //    which appear at every member level in monorepos and must not hide
    //    the workspace-root .agent/tools.json from member files.
    if (existsSync(`${dir}/${CONFIG_BOUNDARY_MARKER}`)) return null
    // 3. Move to parent
    const parent = dirname(dir)
    if (parent === dir) return null // filesystem root
    dir = parent
  }
}

/**
 * Like findConfig, but falls back to ~/.pi/agent/tools.json when no
 * per-repo config exists. Relative command paths in the global config
 * resolve against ~/.pi/agent/ so you can keep helper scripts there.
 */
export function findConfigWithGlobalFallback(filePath: string): FindConfigResult | null {
  const found = findConfig(filePath)
  if (found) return found
  if (existsSync(GLOBAL_FALLBACK_CONFIG)) {
    return { path: GLOBAL_FALLBACK_CONFIG, dir: GLOBAL_FALLBACK_DIR }
  }
  return null
}

export function loadConfig(configPath: string): ToolsConfig {
  try {
    return JSON.parse(readFileSync(configPath, 'utf8')) as ToolsConfig
  } catch {
    return {}
  }
}

export function findProjectRoot(filePath: string): string {
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

// Maps file extensions to the manifest filename that anchors their workspace.
const EXTENSION_MANIFEST: Record<string, string> = {
  '.py':   'pyproject.toml',
  '.pyi':  'pyproject.toml',
  '.ts':   'package.json',
  '.tsx':  'package.json',
  '.js':   'package.json',
  '.jsx':  'package.json',
  '.mjs':  'package.json',
  '.cjs':  'package.json',
  '.rs':   'Cargo.toml',
  '.go':   'go.mod',
}

/**
 * Resolve which manifest file anchors the workspace for a given file,
 * respecting any workspace override in tools.json.
 * Returns null when grouping is disabled or the extension is unknown.
 */
export function manifestForFile(file: string, config: ToolsConfig | null): string | null {
  const ws = config?.workspace
  if (ws === false) return null
  if (typeof ws === 'string') return ws
  if (ws && typeof ws === 'object') {
    const match = findCommand(ws, file)
    if (match !== null) return match
  }
  return EXTENSION_MANIFEST[extname(file)] ?? null
}

/**
 * Find the directory containing the nearest occurrence of `manifest`,
 * walking upward from `filePath`. Returns null if not found.
 */
export function findClosestManifestDir(filePath: string, manifest: string): string | null {
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
 * The manifest is resolved per-file via manifestForFile().
 * Files with no known manifest fall back to findProjectRoot().
 * Returns a Map<manifestDir, files[]> preserving insertion order.
 */
export function groupFilesByManifest(
  files: string[],
  config: ToolsConfig | null,
): Map<string, string[]> {
  const groups = new Map<string, string[]>()
  for (const file of files) {
    const manifest = manifestForFile(file, config)
    const dir = (manifest ? findClosestManifestDir(file, manifest) : null) ?? findProjectRoot(file)
    const group = groups.get(dir) ?? []
    group.push(file)
    groups.set(dir, group)
  }
  return groups
}

// ── Glob matching ─────────────────────────────────────────────────────────────

export function expandBraces(pattern: string): string[] {
  const m = pattern.match(/^(.*)\{([^}]+)\}(.*)$/)
  if (!m) return [pattern]
  const [, pre, inner, post] = m
  return inner.split(',').map((part) => `${pre}${part}${post}`)
}

export function matchesGlob(file: string, pattern: string): boolean {
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

export function findCommand(globs: Record<string, string>, file: string): string | null {
  for (const [pattern, cmd] of Object.entries(globs)) {
    if (matchesGlob(file, pattern)) return cmd
  }
  return null
}

// ── Variable substitution ─────────────────────────────────────────────────────

/**
 * Substitute template variables in a command string.
 *
 * Variables:
 *   {file}        — absolute path of the single file being processed
 *   {files}       — space-separated absolute paths of all files in the current
 *                   manifest group (falls back to {file} if allFiles not given)
 *   {projectRoot} — the workspace manifest root directory
 */
export function substituteVars(
  cmd: string,
  file: string,
  projectRoot: string,
  configDir: string,
  allFiles?: string[],
): string {
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

// ── Command runner ────────────────────────────────────────────────────────────

export async function runCommand(
  cmd: string,
  cwd: string,
  timeoutMs: number,
): Promise<RunResult> {
  try {
    const { stdout, stderr } = await exec(cmd, { cwd, timeout: timeoutMs })
    return { stdout: stdout ?? '', stderr: stderr ?? '', failed: false }
  } catch (err: any) {
    return {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      failed: true,
    }
  }
}

// ── Tier 1: syntax check ──────────────────────────────────────────────────────

export async function runSyntaxCheck(
  file: string,
  config: ToolsConfig | null,
): Promise<string | null> {
  if (config?.syntax === false) return null

  const globs: Record<string, string> =
    config?.syntax && typeof config.syntax === 'object'
      ? config.syntax
      : DEFAULT_SYNTAX

  const rawCmd = findCommand(globs, file)
  if (!rawCmd) return null

  const projectRoot = findProjectRoot(file)
  const cmd = substituteVars(rawCmd, file, projectRoot, projectRoot)
  const result = await runCommand(cmd, projectRoot, SYNTAX_TIMEOUT_MS)

  if (!result.failed) return null

  const output = (result.stderr + result.stdout).trim()
  if (!output) return null // tool not installed — skip silently

  return output
}

// ── Tier 2: format / lint / typecheck ────────────────────────────────────────

/**
 * Run tier-2 checks for a batch of files that share the same workspace manifest root.
 *
 * cwd is set to the manifest directory so that workspace-aware tools
 * (uv, cargo, go, node) always target the correct member.
 *
 * Command templates support two file placeholders:
 *   {file}  — one invocation per file (existing behaviour)
 *   {files} — one invocation for the whole group; all matching files are
 *             passed as space-separated quoted paths in a single shell call
 *
 * Files matched by the same glob pattern are handled together. Files matching
 * different patterns within the same section each run their own command.
 */
export async function runTier2Grouped(
  files: string[],
  cwd: string,
  config: ToolsConfig | null,
  configDir: string,
): Promise<string[]> {
  const errors: string[] = []

  const sections: [Record<string, string> | null, boolean, string][] = [
    [resolveSection(config, 'format',    DEFAULT_FORMAT),    false, 'format'],
    [resolveSection(config, 'lint',      DEFAULT_LINT),      true,  'lint'],
    [resolveSection(config, 'typecheck', DEFAULT_TYPECHECK), true,  'typecheck'],
  ]

  for (const [globs, fatal, label] of sections) {
    if (!globs) continue

    // Bucket files by their matching command template.
    // Different glob patterns within the same section produce separate buckets.
    const cmdToFiles = new Map<string, string[]>()
    for (const file of files) {
      const rawCmd = findCommand(globs, file)
      if (!rawCmd) continue
      const bucket = cmdToFiles.get(rawCmd) ?? []
      bucket.push(file)
      cmdToFiles.set(rawCmd, bucket)
    }

    for (const [rawCmd, matchedFiles] of cmdToFiles) {
      if (rawCmd.includes('{files}')) {
        // Run once for the entire bucket — correct for project-aware tools
        const cmd = substituteVars(rawCmd, matchedFiles[0], cwd, configDir || cwd, matchedFiles)
        const result = await runCommand(cmd, cwd, CHECKS_TIMEOUT_MS)
        if (fatal && result.failed) {
          const output = (result.stderr + result.stdout).trim()
          if (output) errors.push(`[${label}] ${output}`)
        }
      } else {
        // {file}: run per-file but with the correct cwd
        for (const file of matchedFiles) {
          const cmd = substituteVars(rawCmd, file, cwd, configDir || cwd)
          const result = await runCommand(cmd, cwd, CHECKS_TIMEOUT_MS)
          if (fatal && result.failed) {
            const output = (result.stderr + result.stdout).trim()
            if (output) errors.push(`[${label}] ${output}`)
          }
        }
      }
    }
  }

  return errors
}

function resolveSection(
  config: ToolsConfig | null,
  key: 'format' | 'lint' | 'typecheck',
  defaults: Record<string, string>,
): Record<string, string> | null {
  if (config === null) return defaults           // no config → use defaults
  const val = config[key]
  if (val === false) return null                 // explicitly disabled
  if (val && typeof val === 'object') return val // custom globs
  return null                                    // absent → skip
}
