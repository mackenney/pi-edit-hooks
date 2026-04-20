import { join, resolve } from 'node:path';
import type { HookMode } from './types.ts';

export interface SubstituteOptions {
  file: string;
  files?: string[];
  projectRoot: string;
  configDir: string;
  mode: HookMode;
}

/**
 * Shell-quote a string using POSIX single-quote wrapping.
 * Single-quoted strings are completely literal in POSIX shells — no variable
 * expansion, no command substitution, no backslash interpretation. The only
 * character that cannot appear inside single quotes is a single quote itself,
 * which we escape as: '  →  '\''  (close quote, literal ', reopen quote).
 *
 * This is safe against filenames containing $, `, !, spaces, \, etc.
 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Substitute template variables in a command string.
 *
 * Variables:
 *   {file}        — absolute path of the single file
 *   {files}       — space-separated absolute paths (onStop only; degrades to {file} in onEdit)
 *   {projectRoot} — directory containing the config file; any immediately
 *                   following path suffix is included in the same quoted token
 *                   so {projectRoot}/mypy.ini becomes '/project/mypy.ini', not
 *                   '/project'/mypy.ini
 *
 * Auto-append: If command contains neither {file} nor {files}, appends:
 *   - {file} for onEdit mode
 *   - {files} for onStop mode
 *
 * Relative commands (./script.sh, ../bin/check) resolve against configDir and
 * are shell-quoted so spaces in the path are handled correctly.
 */
export function substituteVars(cmd: string, opts: SubstituteOptions): string {
  const absFile = resolve(opts.file);
  let result = cmd;

  if (result.startsWith('./') || result.startsWith('../')) {
    // Extract the script path (up to first space) and quote it; preserve arguments
    const spaceIdx = result.indexOf(' ');
    const rel = spaceIdx === -1 ? result : result.slice(0, spaceIdx);
    const rest = spaceIdx === -1 ? '' : result.slice(spaceIdx);
    result = shellQuote(join(opts.configDir, rel)) + rest;
  }

  const hasFilePlaceholder = result.includes('{file}') || result.includes('{files}');
  if (!hasFilePlaceholder) {
    result = opts.mode === 'onEdit' ? `${result} {file}` : `${result} {files}`;
  }

  result = result.replace(/\{file\}/g, shellQuote(absFile));

  // Capture any path suffix after {projectRoot} so the whole token is quoted
  // together: {projectRoot}/mypy.ini → '/project/mypy.ini'
  result = result.replace(/\{projectRoot\}([^\s]*)/g, (_, suffix) =>
    shellQuote(opts.projectRoot + suffix),
  );

  if (opts.mode === 'onStop' && opts.files && opts.files.length > 0) {
    const filesArg = opts.files.map((f) => shellQuote(resolve(f))).join(' ');
    result = result.replace(/\{files\}/g, filesArg);
  } else {
    result = result.replace(/\{files\}/g, shellQuote(absFile));
  }

  return result;
}
