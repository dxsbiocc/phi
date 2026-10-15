import { buildRemoteMicromambaShellCommand } from '../lib/remote-micromamba-command'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import type { RpcChildEnvironmentResource } from '../lib/rpc-child-resources'

const quote = (value: string): string => "'" + value.replace(/'/gu, "'\\''") + "'"
export function assertRpcChildEnvironment(environment: RpcChildEnvironmentResource): void {
  const execution = environment.execution
  for (const path of [execution.runtimeRoot, execution.prefixPath]) {
    if (realpathSync(path) !== path || !statSync(path).isDirectory())
      throw new Error('Phi child managed environment was replaced')
  }
  const marker = lstatSync(execution.markerPath)
  if (
    !marker.isFile() ||
    marker.isSymbolicLink() ||
    marker.nlink !== 1 ||
    marker.size > 65536 ||
    realpathSync(execution.markerPath) !== execution.markerPath ||
    createHash('sha256').update(readFileSync(execution.markerPath)).digest('hex') !==
      execution.markerSha256 ||
    realpathSync(execution.micromambaPath) !== execution.micromambaPath ||
    !statSync(execution.micromambaPath).isFile() ||
    !(statSync(execution.micromambaPath).mode & 0o111)
  )
    throw new Error('Phi child managed environment lock cannot be verified')
}
/** Recheck in the real shell immediately before exec, beyond the native handler's internal awaits. */
export function rpcChildEnvironmentCommand(
  environment: RpcChildEnvironmentResource,
  command: unknown
): string {
  if (typeof command !== 'string' || !command.trim() || command.includes('\0'))
    throw new Error('Phi child managed bash needs an ordinary command')
  assertRpcChildEnvironment(environment)
  const { prefixPath, micromambaPath, markerPath, markerSha256 } = environment.execution
  const script = [
    'set -eu',
    `[ ! -L ${quote(markerPath)} ] && [ -f ${quote(markerPath)} ]`,
    `[ "$(cd -- ${quote(prefixPath)} && pwd -P)" = ${quote(prefixPath)} ]`,
    `if [ -x '/usr/bin/sha256sum' ]; then phi_env_digest=$('/usr/bin/sha256sum' -- ${quote(markerPath)}); else phi_env_digest=$('/usr/bin/shasum' -a 256 -- ${quote(markerPath)}); fi`,
    `[ "\${phi_env_digest%% *}" = ${quote(markerSha256)} ]`,
    `exec ${buildRemoteMicromambaShellCommand({ binary: micromambaPath, runtimeRoot: environment.execution.runtimeRoot, subcommand: 'run', args: ['-p', prefixPath, '/bin/bash', '-c', command] })}`
  ].join('\n')
  // The pinned SDK embedded shell has no exec builtin; a real POSIX shell owns this guard.
  return `${quote('/bin/sh')} -c ${quote(script)}`
}
