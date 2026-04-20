import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  findConfigWithGlobalFallback,
  groupFilesByManifest,
  loadConfig,
  runSyntaxCheck,
  runTier2Grouped,
} from './core.ts'

const editedFiles = new Set<string>()

export default function (pi: ExtensionAPI) {
  pi.on('tool_result', async (event, _ctx) => {
    if (event.isError) return
    if (event.toolName !== 'write' && event.toolName !== 'edit') return
    const filePath = (event.input as { path?: string }).path
    if (!filePath) return
    const absPath = resolve(filePath)
    if (!existsSync(absPath)) return
    editedFiles.add(absPath)

    const found = findConfigWithGlobalFallback(absPath)
    const config = found ? loadConfig(found.path) : null
    const error = await runSyntaxCheck(absPath, config)
    if (!error) return
    return {
      content: [
        ...event.content,
        { type: 'text' as const, text: `\n⚠ Syntax error in ${filePath}:\n\`\`\`\n${error}\n\`\`\`\nFix before continuing.` },
      ],
    }
  })

  pi.on('agent_end', async (_event, _ctx) => {
    const files = [...editedFiles].filter((f) => existsSync(f))
    editedFiles.clear()
    if (files.length === 0) return

    const allErrors: string[] = []

    // Group by nearest workspace manifest (pyproject.toml, package.json, Cargo.toml,
    // go.mod) so each invocation uses the correct member as cwd — avoids wrong-project
    // discovery with uv, node, cargo, gopls, and their associated linters.
    // Controlled by the `workspace` key in tools.json; auto-detected when absent.
    const firstConfig = (() => {
      const found = findConfigWithGlobalFallback(files[0])
      return found ? loadConfig(found.path) : null
    })()
    const groups = groupFilesByManifest(files, firstConfig)

    for (const [groupDir, groupFiles] of groups) {
      // All files in the same manifest root share the same config
      const found = findConfigWithGlobalFallback(groupFiles[0])
      const config = found ? loadConfig(found.path) : null
      const configDir = found?.dir ?? ''
      const errors = await runTier2Grouped(groupFiles, groupDir, config, configDir)
      if (errors.length > 0) allErrors.push(`**${groupDir}**\n${errors.join('\n')}`)
    }

    if (allErrors.length === 0) return
    pi.sendUserMessage(
      `Checks failed after edits. Fix the following issues:\n\n${allErrors.join('\n\n')}`,
      { deliverAs: 'followUp' },
    )
  })
}
