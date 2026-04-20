import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { SessionState, GlobCommands, HookMode } from './types.ts'
import { findCommand, normalizeCommand } from './glob.ts'
import { substituteVars } from './substitute.ts'
import { getGitRoot } from './discover.ts'
import { resolveConfig } from './resolve.ts'
import { runCommand, groupFilesByManifest, CHECKS_TIMEOUT_MS, SYNTAX_TIMEOUT_MS } from './core.ts'

let state: SessionState | null = null

function ensureState(cwd: string): SessionState {
  if (!state) {
    // Defensive fallback — should not happen if session_start fires first
    state = { boundary: cwd, editedFiles: new Set() }
  }
  return state
}

/**
 * Run onEdit commands for a single file.
 * Returns output to append to tool result, or null if no output.
 */
async function runOnEditCommands(
  filePath: string,
  globs: GlobCommands,
  projectRoot: string,
): Promise<string | null> {
  const commandValue = findCommand(globs, filePath)
  if (commandValue === null) return null

  const commands = normalizeCommand(commandValue)
  if (!commands) return null

  const outputs: string[] = []

  for (const rawCmd of commands) {
    const cmd = substituteVars(rawCmd, {
      file: filePath,
      projectRoot,
      configDir: projectRoot,
      mode: 'onEdit' as HookMode,
    })

    const result = await runCommand(cmd, projectRoot, SYNTAX_TIMEOUT_MS)

    // Collect output regardless of success/failure (informational)
    const output = (result.stderr + result.stdout).trim()
    if (output) {
      outputs.push(output)
    }
  }

  return outputs.length > 0 ? outputs.join('\n') : null
}

/**
 * Run onStop commands for a group of files sharing the same manifest.
 * Returns array of error messages.
 */
async function runOnStopForGroup(
  files: string[],
  cwd: string,
  globs: GlobCommands,
  projectRoot: string,
): Promise<string[]> {
  const errors: string[] = []

  // Bucket files by matching command (same command = batch together)
  const cmdToFiles = new Map<string, string[]>()

  for (const file of files) {
    const commandValue = findCommand(globs, file)
    if (commandValue === null) continue

    const commands = normalizeCommand(commandValue)
    if (!commands) continue

    for (const rawCmd of commands) {
      const bucket = cmdToFiles.get(rawCmd) ?? []
      bucket.push(file)
      cmdToFiles.set(rawCmd, bucket)
    }
  }

  for (const [rawCmd, matchedFiles] of cmdToFiles) {
    // Commands without {file} explicitly are batch (auto-append adds {files} for onStop)
    const usesBatch = rawCmd.includes('{files}') ||
                      (!rawCmd.includes('{file}') && !rawCmd.includes('{files}'))

    if (usesBatch) {
      // Single invocation for all files
      const cmd = substituteVars(rawCmd, {
        file: matchedFiles[0],
        files: matchedFiles,
        projectRoot,
        configDir: projectRoot,
        mode: 'onStop' as HookMode,
      })

      const result = await runCommand(cmd, cwd, CHECKS_TIMEOUT_MS)
      if (result.failed) {
        const output = (result.stderr + result.stdout).trim()
        if (output) errors.push(`[onStop] ${output}`)
      }
    } else {
      // Per-file invocation
      for (const file of matchedFiles) {
        const cmd = substituteVars(rawCmd, {
          file,
          projectRoot,
          configDir: projectRoot,
          mode: 'onStop' as HookMode,
        })

        const result = await runCommand(cmd, cwd, CHECKS_TIMEOUT_MS)
        if (result.failed) {
          const output = (result.stderr + result.stdout).trim()
          if (output) errors.push(`[onStop] ${output}`)
        }
      }
    }
  }

  return errors
}

export default function (pi: ExtensionAPI) {
  // session_start: Initialize boundary and state
  pi.on('session_start', async (_event: any, ctx: any) => {
    const boundary = await getGitRoot(ctx.cwd) ?? ctx.cwd
    state = { boundary, editedFiles: new Set() }
  })

  // tool_result: onEdit hooks (informational)
  pi.on('tool_result', async (event: any, ctx: any) => {
    if (event.isError) return
    if (event.toolName !== 'write' && event.toolName !== 'edit') return

    const filePath = (event.input as { path?: string }).path
    if (!filePath) return

    const absPath = resolve(filePath)
    if (!existsSync(absPath)) return

    // Always accumulate, even if no onEdit commands match
    const s = ensureState(ctx.cwd)
    s.editedFiles.add(absPath)

    // Resolve config for this file
    const config = resolveConfig(absPath, s.boundary)
    if (!config || !config.onEdit) return

    const output = await runOnEditCommands(absPath, config.onEdit, config.projectRoot)
    if (!output) return

    // Append output to tool result (informational, never blocks)
    return {
      content: [
        ...event.content,
        {
          type: 'text' as const,
          text: `\n⚠ onEdit: ${filePath}\n\`\`\`\n${output}\n\`\`\``,
        },
      ],
    }
  })

  // agent_end: onStop hooks (fatal)
  pi.on('agent_end', async (_event: any, ctx: any) => {
    const s = ensureState(ctx.cwd)
    const files = [...s.editedFiles].filter(f => existsSync(f))
    s.editedFiles.clear()

    if (files.length === 0) return

    const allErrors: string[] = []

    // Group files by nearest workspace manifest
    // Use first file's config for grouping (workspace key)
    const firstConfig = resolveConfig(files[0], s.boundary)
    const groups = groupFilesByManifest(files, firstConfig ? { workspace: undefined } : null)

    for (const [groupDir, groupFiles] of groups) {
      // Resolve config for this group (may differ from other groups)
      const config = resolveConfig(groupFiles[0], s.boundary)
      if (!config || !config.onStop) continue

      const errors = await runOnStopForGroup(
        groupFiles,
        groupDir,
        config.onStop,
        config.projectRoot,
      )

      if (errors.length > 0) {
        allErrors.push(`**${groupDir}**\n${errors.join('\n')}`)
      }
    }

    if (allErrors.length === 0) return

    // Send followUp to force agent to address errors
    pi.sendUserMessage(
      `Checks failed after edits. Fix the following issues:\n\n${allErrors.join('\n\n')}`,
      { deliverAs: 'followUp' },
    )
  })
}
