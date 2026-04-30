import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { keyHint } from '@mariozechner/pi-coding-agent';
import { Text } from '@mariozechner/pi-tui';
import { CHECKS_TIMEOUT_MS, groupFilesByManifest, runCommand, SYNTAX_TIMEOUT_MS } from './core.ts';
import { getGitRoot } from './discover.ts';
import { findCommand, normalizeCommand } from './glob.ts';
import { resolveConfig } from './resolve.ts';
import { substituteVars } from './substitute.ts';
import type { GlobCommands, HookMode, SessionState } from './types.ts';

let state: SessionState | null = null;

function ensureState(cwd: string): SessionState {
  if (!state) {
    // Defensive fallback — should not happen if session_start fires first
    state = { boundary: cwd, editedFiles: new Set() };
  }
  return state;
}

/**
 * Run onEdit commands for a single file.
 * Returns output to append to tool result, or null if no output.
 */
async function runOnEditCommands(
  filePath: string,
  globs: GlobCommands,
  projectRoot: string,
): Promise<{ output: string; failed: boolean; cmds: string[] } | null> {
  const commandValue = findCommand(globs, filePath);
  if (commandValue === null) return null;

  const commands = normalizeCommand(commandValue);
  if (!commands) return null;

  const outputs: string[] = [];
  const cmds: string[] = [];
  let failed = false;

  for (const rawCmd of commands) {
    const cmd = substituteVars(rawCmd, {
      file: filePath,
      projectRoot,
      configDir: projectRoot,
      mode: 'onEdit' as HookMode,
    });

    cmds.push(cmd);
    const result = await runCommand(cmd, projectRoot, SYNTAX_TIMEOUT_MS);
    if (result.failed) failed = true;

    // Collect output regardless of success/failure (informational)
    const output = (result.stderr + result.stdout).trim();
    if (output) {
      outputs.push(output);
    }
  }

  if (outputs.length === 0) return null;
  return { output: outputs.join('\n'), failed, cmds };
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
): Promise<{ infos: string[]; errors: string[] }> {
  const infos: string[] = [];
  const errors: string[] = [];

  // Bucket files by matching command (same command = batch together)
  const cmdToFiles = new Map<string, string[]>();

  for (const file of files) {
    const commandValue = findCommand(globs, file);
    if (commandValue === null) continue;

    const commands = normalizeCommand(commandValue);
    if (!commands) continue;

    for (const rawCmd of commands) {
      const bucket = cmdToFiles.get(rawCmd) ?? [];
      bucket.push(file);
      cmdToFiles.set(rawCmd, bucket);
    }
  }

  for (const [rawCmd, matchedFiles] of cmdToFiles) {
    if (rawCmd.includes('{files}')) {
      // Batch: single invocation with all matched files
      const cmd = substituteVars(rawCmd, {
        file: matchedFiles[0],
        files: matchedFiles,
        projectRoot,
        configDir: projectRoot,
        mode: 'onStop' as HookMode,
      });

      const result = await runCommand(cmd, cwd, CHECKS_TIMEOUT_MS);
      const output = (result.stderr + result.stdout).trim();
      if (result.failed) {
        if (output) errors.push(`$ ${cmd}\n✗ ${output}`);
      } else {
        if (output) infos.push(`$ ${cmd}\n✓ ${output}`);
      }
    } else if (rawCmd.includes('{file}')) {
      // Per-file: one invocation per file
      for (const file of matchedFiles) {
        const cmd = substituteVars(rawCmd, {
          file,
          projectRoot,
          configDir: projectRoot,
          mode: 'onStop' as HookMode,
        });

        const result = await runCommand(cmd, cwd, CHECKS_TIMEOUT_MS);
        const output = (result.stderr + result.stdout).trim();
        if (result.failed) {
          if (output) errors.push(`$ ${cmd}\n✗ ${output}`);
        } else {
          if (output) infos.push(`$ ${cmd}\n✓ ${output}`);
        }
      }
    } else {
      // Singleton: no placeholder — run once with no file args (e.g. npx tsc --noEmit)
      const cmd = substituteVars(rawCmd, {
        file: matchedFiles[0],
        projectRoot,
        configDir: projectRoot,
        mode: 'onStop' as HookMode,
      });

      const result = await runCommand(cmd, cwd, CHECKS_TIMEOUT_MS);
      const output = (result.stderr + result.stdout).trim();
      if (result.failed) {
        if (output) errors.push(`$ ${cmd}\n✗ ${output}`);
      } else {
        if (output) infos.push(`$ ${cmd}\n✓ ${output}`);
      }
    }
  }

  return { infos, errors };
}

export default function (pi: ExtensionAPI) {
  const COLLAPSED_LINES = 15;

  pi.on('before_agent_start', async (event: any, _ctx: any) => {
    const guidelines = [
      '## Edit Hooks (pi-edit-hooks)',
      '- **onEdit**: runs after each write/edit; output appended to the tool result. Shows resolved config and the exact command executed.',
      '- **onStop**: runs after your turn ends; delivered as a follow-up message. Shows the exact command executed. Errors trigger a new turn; clean output is informational only.',
    ].join('\n');
    return { systemPrompt: `${event.systemPrompt}\n\n${guidelines}` };
  });

  pi.registerMessageRenderer('pi-edit-hooks', (message, options, theme) => {
    const { expanded } = options;
    const lines = (message.content as string).split('\n');

    const colorLine = (line: string) => {
      if (line.startsWith('✓')) return theme.fg('success', line);
      if (line.startsWith('✗')) return theme.fg('error', line);
      if (line.startsWith('**')) return theme.bold(line.replace(/\*\*/g, '') + ':');
      return theme.fg('dim', line);
    };

    const visible = !expanded && lines.length > COLLAPSED_LINES
      ? lines.slice(0, COLLAPSED_LINES)
      : lines;

    let rendered = visible.map(colorLine).join('\n');

    if (!expanded && lines.length > COLLAPSED_LINES) {
      const remaining = lines.length - COLLAPSED_LINES;
      rendered += `\n${theme.fg('muted', `… ${remaining} more lines (${keyHint('app.tools.expand', 'to expand')})`)}`;
    }

    return new Text(rendered, 1, 0);
  });

  // session_start: Initialize boundary and state
  pi.on('session_start', async (_event: any, ctx: any) => {
    const boundary = (await getGitRoot(ctx.cwd)) ?? ctx.cwd;
    state = { boundary, editedFiles: new Set() };
  });

  // tool_result: onEdit hooks (informational)
  pi.on('tool_result', async (event: any, ctx: any) => {
    if (event.isError) return;
    if (event.toolName !== 'write' && event.toolName !== 'edit') return;

    const filePath = (event.input as { path?: string }).path;
    if (!filePath) return;

    const absPath = resolve(filePath);
    if (!existsSync(absPath)) return;

    // Always accumulate, even if no onEdit commands match
    const s = ensureState(ctx.cwd);
    s.editedFiles.add(absPath);

    // Resolve config for this file
    const config = resolveConfig(absPath, s.boundary);
    if (!config?.onEdit) return;

    const result = await runOnEditCommands(absPath, config.onEdit, config.projectRoot);
    if (!result) return;

    if (result.failed) ctx.ui.notify(`⚠️ onEdit: ${filePath}`, 'warning');

    // Append output to tool result (informational, never blocks)
    return {
      content: [
        ...event.content,
        {
          type: 'text' as const,
          text: `\n⚠ onEdit\n  config: ${config.configSource}\n  commands: ${result.cmds.join(' | ')}\n\`\`\`\n${result.output}\n\`\`\``,
        },
      ],
    };
  });

  // agent_end: onStop hooks (fatal)
  pi.on('agent_end', async (_event: any, ctx: any) => {
    const s = ensureState(ctx.cwd);
    const files = [...s.editedFiles].filter((f) => existsSync(f));
    s.editedFiles.clear();

    if (files.length === 0) return;

    const allInfos: string[] = [];
    const allErrors: string[] = [];

    // Resolve config for the first file to get the workspace grouping setting.
    // workspace is now threaded through ResolvedConfig so it actually takes effect.
    const firstConfig = resolveConfig(files[0], s.boundary);
    const groups = groupFilesByManifest(
      files,
      firstConfig ? { workspace: firstConfig.workspace } : null,
    );

    for (const [groupDir, groupFiles] of groups) {
      // Resolve config for this group (may differ across groups in a monorepo)
      const config = resolveConfig(groupFiles[0], s.boundary);
      if (!config?.onStop) continue;

      const { infos, errors } = await runOnStopForGroup(
        groupFiles,
        groupDir,
        config.onStop,
        config.projectRoot,
      );

      const lines: string[] = [...infos, ...errors];
      if (lines.length > 0) {
        const target = errors.length > 0 ? allErrors : allInfos;
        target.push(`**${groupDir}**\n${lines.join('\n')}`);
      }
    }

    if (allInfos.length === 0 && allErrors.length === 0) return;

    if (allErrors.length === 0) {
      pi.sendMessage(
        {
          customType: 'pi-edit-hooks',
          content: `onStop checks after edits:\n\n${allInfos.join('\n\n')}`,
          display: true,
        },
        { deliverAs: 'followUp', triggerTurn: false },
      );
      return;
    }

    const sections: string[] = [];
    if (allInfos.length > 0) sections.push(allInfos.join('\n\n'));
    sections.push(allErrors.join('\n\n'));

    pi.sendMessage(
      {
        customType: 'pi-edit-hooks',
        content: `onStop checks after edits:\n\n${sections.join('\n\n')}`,
        display: true,
      },
      { deliverAs: 'followUp', triggerTurn: true },
    );
  });
}
