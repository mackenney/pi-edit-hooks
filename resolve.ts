import { relative, resolve } from 'node:path'
import type {
  FlatConfig,
  GlobCommands,
  PathKeyedConfig,
  ResolvedConfig,
  FoundConfig,
} from './types.ts'
import { isPathKeyedConfig } from './types.ts'
import { discoverConfigs } from './discover.ts'

/**
 * Find which section of a path-keyed config applies to a file.
 * Uses longest-prefix match.
 *
 * @param config The path-keyed config
 * @param filePath Absolute path of the edited file
 * @param configDir Directory containing .pi/ (parent of .pi/)
 * @returns The matching section, false (disabled), or null (no match)
 */
export function resolvePathKeyedSection(
  config: PathKeyedConfig,
  filePath: string,
  configDir: string,
): FlatConfig | false | null {
  const absFile = resolve(filePath)
  const absConfigDir = resolve(configDir)

  const relPath = relative(absConfigDir, absFile)

  if (relPath.startsWith('..')) {
    return null
  }

  const matches: Array<{ key: string; length: number; section: FlatConfig | false }> = []

  for (const [key, section] of Object.entries(config)) {
    if (key === '.') {
      matches.push({ key, length: 0, section })
    } else {
      const normalizedKey = key.replace(/\/$/, '')

      if (relPath === normalizedKey || relPath.startsWith(normalizedKey + '/')) {
        matches.push({ key, length: normalizedKey.length, section })
      }
    }
  }

  if (matches.length === 0) {
    return null
  }

  matches.sort((a, b) => b.length - a.length)
  return matches[0].section
}

/**
 * Merge global and project configs at section level.
 * Project sections replace global sections entirely (no deep merge).
 *
 * @param global Global config (flat format only)
 * @param project Project config after path-key resolution (flat format)
 */
export function mergeConfigs(
  global: FlatConfig | null,
  project: FlatConfig | null,
): { onEdit: GlobCommands | null; onStop: GlobCommands | null } {
  let onEdit: GlobCommands | null = null
  let onStop: GlobCommands | null = null

  if (global) {
    if (global.onEdit) {
      onEdit = global.onEdit
    }
    if (global.onStop) {
      onStop = global.onStop
    }
  }

  if (project) {
    if ('onEdit' in project) {
      onEdit = project.onEdit === false ? null : (project.onEdit ?? null)
    }
    if ('onStop' in project) {
      onStop = project.onStop === false ? null : (project.onStop ?? null)
    }
  }

  return { onEdit, onStop }
}

/**
 * Resolve the final config for a specific file.
 * Handles path-keyed resolution and global/project merging.
 *
 * @param filePath Path of the edited file
 * @param boundary Git root or cwd (stops config walk-up)
 * @returns Resolved config, or null if no config found
 */
export function resolveConfig(
  filePath: string,
  boundary: string,
): ResolvedConfig | null {
  const { project, global } = discoverConfigs(filePath, boundary)

  if (!project && !global) {
    return null
  }

  let projectSection: FlatConfig | null = null
  let projectRoot: string

  if (project) {
    projectRoot = project.configDir

    if (isPathKeyedConfig(project.config)) {
      const section = resolvePathKeyedSection(project.config, filePath, project.configDir)

      if (section === false) {
        return { onEdit: null, onStop: null, projectRoot }
      }

      projectSection = section
    } else {
      projectSection = project.config as FlatConfig
    }
  } else {
    projectRoot = global!.configDir
  }

  const globalSection =
    global && !isPathKeyedConfig(global.config) ? (global.config as FlatConfig) : null

  const merged = mergeConfigs(globalSection, projectSection)

  return {
    onEdit: merged.onEdit,
    onStop: merged.onStop,
    projectRoot,
  }
}
