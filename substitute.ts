import { join, resolve } from 'node:path'
import type { HookMode } from './types.ts'

export interface SubstituteOptions {
  file: string
  files?: string[]
  projectRoot: string
  configDir: string
  mode: HookMode
}

function shellQuote(path: string): string {
  const escaped = path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `"${escaped}"`
}

/**
 * Substitute template variables in a command string.
 *
 * Variables:
 *   {file}        — absolute path of the single file
 *   {files}       — space-separated absolute paths (onStop only; degrades to {file} in onEdit)
 *   {projectRoot} — directory containing the config file
 *
 * Auto-append: If command contains neither {file} nor {files}, appends:
 *   - {file} for onEdit mode
 *   - {files} for onStop mode
 *
 * Relative commands (./script.sh, ../bin/check) resolve against configDir.
 */
export function substituteVars(cmd: string, opts: SubstituteOptions): string {
  const absFile = resolve(opts.file)
  let result = cmd

  if (result.startsWith('./') || result.startsWith('../')) {
    result = join(opts.configDir, result)
  }

  const hasFilePlaceholder = result.includes('{file}') || result.includes('{files}')
  if (!hasFilePlaceholder) {
    result = opts.mode === 'onEdit'
      ? `${result} {file}`
      : `${result} {files}`
  }

  result = result.replace(/\{file\}/g, shellQuote(absFile))
  result = result.replace(/\{projectRoot\}/g, shellQuote(opts.projectRoot))

  if (opts.mode === 'onStop' && opts.files && opts.files.length > 0) {
    const filesArg = opts.files.map(f => shellQuote(resolve(f))).join(' ')
    result = result.replace(/\{files\}/g, filesArg)
  } else {
    result = result.replace(/\{files\}/g, shellQuote(absFile))
  }

  return result
}
