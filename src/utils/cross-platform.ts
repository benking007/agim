// Cross-platform utilities for Windows compatibility

import { spawn, type SpawnOptions, type ChildProcess } from 'node:child_process'
import { platform } from 'node:os'

export const isWindows = platform() === 'win32'
export const isMac = platform() === 'darwin'
export const isLinux = platform() === 'linux'

/**
 * Cross-platform spawn wrapper that automatically handles Windows compatibility.
 * On Windows, it sets shell: true to enable command execution.
 *
 * Note: When using stdio: ['ignore', 'pipe', 'pipe'], stdout and stderr are guaranteed to be non-null.
 */
export function crossSpawn(
  command: string,
  args: string[] = [],
  options: SpawnOptions = {}
): ChildProcess {
  const spawnOptions: SpawnOptions = {
    ...options,
    // On Windows, we need shell: true for commands like 'claude', 'opencode', etc.
    // to be found in PATH and executed properly.
    shell: isWindows ? (options.shell ?? true) : options.shell,
  }
  return spawn(command, args, spawnOptions)
}

/**
 * Check if a command exists in PATH.
 * Uses 'where' on Windows, 'which' on Unix.
 */
export function commandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const checkCmd = isWindows ? 'where' : 'which'
    const proc = crossSpawn(checkCmd, [command], { stdio: 'ignore' })
    proc.on('close', (code) => resolve(code === 0))
    proc.on('error', () => resolve(false))
  })
}

/**
 * Get the correct newline character for the current platform.
 */
export const EOL = isWindows ? '\r\n' : '\n'
