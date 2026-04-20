import { basename } from 'node:path'

import type { CommandValue, GlobCommands } from './types.ts'

/**
 * Expand a single brace group in a glob pattern.
 * "*.{ts,tsx}" → ["*.ts", "*.tsx"]
 * No nested braces support (not needed for config use cases).
 */
export function expandBraces(pattern: string): string[] {
  const m = pattern.match(/^(.*)\{([^}]+)\}(.*)$/)
  if (!m) return [pattern]
  const [, pre, inner, post] = m
  return inner.split(',').map((part) => `${pre}${part}${post}`)
}

/**
 * Test if a file matches a glob pattern.
 * Matches against basename only (no path components).
 * Supports * wildcard and brace expansion.
 */
export function matchesGlob(file: string, pattern: string): boolean {
  const name = basename(file)
  for (const expanded of expandBraces(pattern)) {
    // Escape all regex metacharacters EXCEPT *, then convert * to .*
    const escaped = expanded
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
    const regex = new RegExp(`^${escaped}$`)
    if (regex.test(name)) return true
  }
  return false
}

/**
 * Find the first matching command for a file.
 * Returns null if no glob matches.
 * First match wins — order matters.
 */
export function findCommand(globs: GlobCommands, file: string): CommandValue | null {
  for (const [pattern, cmd] of Object.entries(globs)) {
    if (matchesGlob(file, pattern)) return cmd
  }
  return null
}

/**
 * Normalize a command value to an array of strings or null (disabled).
 */
export function normalizeCommand(value: CommandValue): string[] | null {
  if (value === false) return null
  if (value === '') return null
  if (Array.isArray(value)) {
    if (value.length === 0) return null
    return value
  }
  return [value]
}
