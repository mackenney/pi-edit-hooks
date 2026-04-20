/** A single command string, a sequential array, or a disable marker */
export type CommandValue = string | string[] | false

/** Maps glob patterns to commands */
export type GlobCommands = Record<string, CommandValue>

export interface FlatConfig {
  onEdit?: GlobCommands | false
  onStop?: GlobCommands | false
  /** Workspace manifest override for {files} grouping */
  workspace?: string | Record<string, string> | false
}

/**
 * Keys are paths relative to config file location.
 * "." = root default, "frontend/" = subdirectory scope.
 * `false` disables all checks for that subtree.
 */
export type PathKeyedConfig = Record<string, FlatConfig | false>

/** Config as read from disk (before resolution) */
export type RawConfig = FlatConfig | PathKeyedConfig

/** The final config used for a specific file */
export interface ResolvedConfig {
  onEdit: GlobCommands | null
  onStop: GlobCommands | null
  projectRoot: string
}

export interface FoundConfig {
  config: RawConfig
  configDir: string
}

export interface SessionState {
  boundary: string
  editedFiles: Set<string>
}

export interface RunResult {
  stdout: string
  stderr: string
  failed: boolean
}

export type HookMode = 'onEdit' | 'onStop'

/**
 * Detect if a config uses path-keyed format.
 * Path-keyed if ANY top-level key contains '/' or equals '.'
 */
export function isPathKeyedConfig(config: RawConfig): config is PathKeyedConfig {
  return Object.keys(config).some(key => key === '.' || key.includes('/'))
}
