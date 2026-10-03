import { accessSync, constants, readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'

export const TERMINAL_MINIMAL_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

const ALLOWED_ENVIRONMENT_KEYS = new Set([
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SSH_AUTH_SOCK'
])

export interface TerminalShellLaunch {
  application: string
  args: ['-il']
  fallbackReason?: string
}

export type TerminalFileExists = (path: string) => boolean
export type TerminalShellsReader = () => string

export function buildTerminalEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && (ALLOWED_ENVIRONMENT_KEYS.has(key) || key.startsWith('LC_'))) {
      result[key] = value
    }
  }

  if (result.LANG === undefined) result.LANG = 'en_US.UTF-8'
  result.TERM = 'xterm-256color'
  result.COLORTERM = 'truecolor'
  result.TERM_PROGRAM = 'Phi'
  result.PATH = TERMINAL_MINIMAL_PATH
  return result
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function readSystemShells(): string {
  try {
    return readFileSync('/etc/shells', 'utf8')
  } catch {
    return ''
  }
}

function listedShells(readShells: TerminalShellsReader): Set<string> {
  return new Set(
    readShells()
      .split(/\r?\n/u)
      .map((line) => line.replace(/#.*$/u, '').trim())
      .filter((line) => line.startsWith('/'))
  )
}

function requestedShellFailure(
  shell: string | undefined,
  shells: ReadonlySet<string>,
  fileExists: TerminalFileExists
): string | undefined {
  if (!shell) return 'SHELL is not set'
  if (!isAbsolute(shell)) return 'SHELL must be an absolute path'
  if (!shells.has(shell)) return `${shell} is not listed in /etc/shells`
  if (!fileExists(shell)) return `${shell} is not executable`
  return undefined
}

export function resolveTerminalShell(
  env: NodeJS.ProcessEnv,
  fileExists: TerminalFileExists = isExecutable,
  readShells: TerminalShellsReader = readSystemShells
): TerminalShellLaunch {
  const shells = listedShells(readShells)
  const fallbackReason = requestedShellFailure(env.SHELL, shells, fileExists)
  if (!fallbackReason && env.SHELL) {
    return { application: env.SHELL, args: ['-il'] }
  }

  for (const application of ['/bin/zsh', '/bin/bash']) {
    if (fileExists(application)) return { application, args: ['-il'], fallbackReason }
  }

  throw new Error('No supported terminal shell is executable')
}
