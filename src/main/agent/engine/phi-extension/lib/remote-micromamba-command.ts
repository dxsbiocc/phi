import { posix } from 'node:path'

const shellQuote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'"
type HostCommand = readonly [string, ...string[]]

export type RemoteMicromambaSubcommand =
  'create' | 'info' | 'install' | 'list' | 'run' | 'shell' | 'version'

export interface RemoteMicromambaCommandInput {
  binary: string
  runtimeRoot: string
  subcommand: RemoteMicromambaSubcommand
  args?: readonly string[]
}

const TASK_SUBCOMMANDS = new Set<RemoteMicromambaSubcommand>(['run', 'shell'])

function micromambaArguments(input: RemoteMicromambaCommandInput): string[] {
  const args = [...(input.args ?? [])]
  if (input.subcommand === 'version') return ['--version', ...args]
  // micromamba 2.9.0 does not expose --no-rc consistently on run/shell hook.
  // Those paths still start from env -i and use the supported global rc-file switch.
  if (TASK_SUBCOMMANDS.has(input.subcommand)) {
    return ['--rc-file', '/dev/null', input.subcommand, ...args]
  }
  return [input.subcommand, '--no-rc', ...args]
}

function isolatedEnvironment(input: RemoteMicromambaCommandInput): string[] {
  const path = TASK_SUBCOMMANDS.has(input.subcommand)
    ? 'PATH="${PATH:-/usr/bin:/bin}"'
    : `PATH=${shellQuote('/usr/bin:/bin')}`
  return [
    'HOME="${HOME:-/}"',
    path,
    'TMPDIR="${TMPDIR:-/tmp}"',
    `XDG_CACHE_HOME=${shellQuote(posix.join(input.runtimeRoot, 'cache'))}`,
    `MAMBA_ROOT_PREFIX=${shellQuote(input.runtimeRoot)}`,
    `MAMBA_PKGS_DIRS=${shellQuote(posix.join(input.runtimeRoot, 'pkgs'))}`
  ]
}

export function buildRemoteMicromambaShellCommand(input: RemoteMicromambaCommandInput): string {
  const invocation = [input.binary, ...micromambaArguments(input)].map(shellQuote)
  return ['env', '-i', ...isolatedEnvironment(input), ...invocation].join(' ')
}

export function buildRemoteMicromambaHostCommand(input: RemoteMicromambaCommandInput): HostCommand {
  return ['sh', '-c', `exec ${buildRemoteMicromambaShellCommand(input)}`, 'phi-micromamba']
}
