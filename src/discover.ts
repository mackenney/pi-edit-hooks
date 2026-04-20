import { exec as execCb } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { FoundConfig, RawConfig } from './types.ts';

const exec = promisify(execCb);

export const CONFIG_DIR = '.pi';
export const CONFIG_FILE = 'edit-hooks.json';
export const GLOBAL_CONFIG_PATH = join(homedir(), '.pi', 'agent', CONFIG_FILE);
export const GLOBAL_CONFIG_DIR = join(homedir(), '.pi', 'agent');

/**
 * Get the git repository root for a directory.
 * Returns null if not in a git repository.
 */
export async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git rev-parse --show-toplevel', { cwd });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Parse and validate a config file.
 * Returns null if file doesn't exist, is invalid JSON, or fails validation.
 * Logs warnings for invalid configs but does not throw.
 */
export function parseConfigFile(configPath: string): RawConfig | null {
  try {
    const content = readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(content);

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      console.warn(`[pi-edit-hooks] Invalid config at ${configPath}: not an object`);
      return null;
    }

    return parsed as RawConfig;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[pi-edit-hooks] Failed to parse ${configPath}: ${err}`);
    }
    return null;
  }
}

/**
 * Find project config by walking up from filePath.
 * Stops at the boundary directory (git root or cwd fallback).
 * Returns null if no config found.
 */
export function findProjectConfig(filePath: string, boundary: string): FoundConfig | null {
  let dir = dirname(resolve(filePath));
  const boundaryAbs = resolve(boundary);

  while (true) {
    const candidate = join(dir, CONFIG_DIR, CONFIG_FILE);
    if (existsSync(candidate)) {
      const config = parseConfigFile(candidate);
      if (config !== null) {
        return { config, configDir: dir };
      }
      // Invalid config — continue searching up
    }

    if (dir === boundaryAbs) {
      return null;
    }

    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }

    dir = parent;
  }
}

/**
 * Load the global config from ~/.pi/agent/edit-hooks.json.
 * Returns null if file doesn't exist or is invalid.
 */
export function loadGlobalConfig(): FoundConfig | null {
  if (!existsSync(GLOBAL_CONFIG_PATH)) {
    return null;
  }

  const config = parseConfigFile(GLOBAL_CONFIG_PATH);
  if (config === null) {
    return null;
  }

  return { config, configDir: GLOBAL_CONFIG_DIR };
}

/**
 * Find config for a file, checking project then global.
 * Project config takes precedence over global.
 * Returns both configs when available (for merge step).
 */
export function discoverConfigs(
  filePath: string,
  boundary: string,
): { project: FoundConfig | null; global: FoundConfig | null } {
  const project = findProjectConfig(filePath, boundary);
  const global = loadGlobalConfig();
  return { project, global };
}
