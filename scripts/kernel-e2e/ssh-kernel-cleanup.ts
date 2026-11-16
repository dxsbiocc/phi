import { deriveKernelSocketPaths } from '../../src/kernel/lifecycle/paths'
import {
  kernelSocketIdentity,
  type LaunchedRemoteKernel
} from '../../src/main/agent/engine/kernel-client/remote/launcher'
import { HelperRpcClient } from '../../src/main/agent/workspace-host/helper-rpc'
import type { CommandResult } from '../../src/main/agent/workspace-host/types'
import { shellQuote, type RemoteSshSession } from '../../src/main/agent/wrappers/remote-ssh-session'

const GRACEFUL_SHUTDOWN_POLLS = 30
const FORCED_SHUTDOWN_POLLS = 20

/** A failed SSH command is not evidence that a process exited. */
export async function remoteProcessAlive(
  session: Pick<RemoteSshSession, 'exec'>,
  pid: number
): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid process ID')
  const result = await session.exec(
    `test -d /proc/self || exit 1; if kill -0 ${pid} 2>/dev/null; then printf alive; elif test ! -d /proc/${pid}; then printf absent; else exit 1; fi`
  )
  if (result.code !== 0 || result.signal || !['alive', 'absent'].includes(result.stdout)) {
    throw new Error('Remote process inspection failed')
  }
  return result.stdout === 'alive'
}

/**
 * Close the controller first so the kernel's normal disconnect grace path can
 * dispose sessions and remove its socket. The fallback is deliberately tied to
 * both the verified executable and this deployment's exact socket argument.
 */
export function buildSshKernelShutdownCommand(launch: LaunchedRemoteKernel): string {
  const identity = kernelSocketIdentity(launch.deployment, {
    home: launch.homePath,
    agentDir: launch.agentDir
  })
  const { stem } = deriveKernelSocketPaths(launch.deployment.runtimeRoot, identity, 0)
  const executable = shellQuote(launch.deployment.executablePath)
  const quotedStem = shellQuote(stem)

  return [
    'phi_kernel_dir="/tmp/phi-k-$(id -u)"',
    `phi_kernel_stem=${quotedStem}`,
    'phi_kernel_socket="$phi_kernel_dir/$phi_kernel_stem.sock"',
    'phi_kernel_token="$phi_kernel_dir/$phi_kernel_stem.token"',
    `phi_kernel_executable=${executable}`,
    'phi_kernel_cleanup=graceful',
    'phi_kernel_pids() {',
    // Only this user's processes: a full /proc scan per poll is too slow on busy cluster nodes.
    '  phi_user_pids="$(ps -u "$(id -u)" -o pid=)" || return 1',
    '  for phi_pid in $phi_user_pids; do',
    '    phi_proc="/proc/$phi_pid"',
    '    phi_args="$(tr \'\\000\' \'\\n\' < "$phi_proc/cmdline" 2>/dev/null)" || { [ ! -d "$phi_proc" ] && continue; return 1; }',
    '    printf \'%s\\n\' "$phi_args" | grep -Fqx -- "$phi_kernel_socket" || continue',
    '    [ "$(printf \'%s\\n\' "$phi_args" | sed -n \'1p\')" = "$phi_kernel_executable" ] || return 1',
    '    [ "$(printf \'%s\\n\' "$phi_args" | sed -n \'2,5p\')" = "$(printf \'%s\\n\' --listen "$phi_kernel_socket" --token-file "$phi_kernel_token")" ] || return 1',
    '    phi_actual_exe="$(readlink "$phi_proc/exe" 2>/dev/null)" || { [ ! -d "$phi_proc" ] && continue; return 1; }',
    // Docker Desktop's x64 translator owns /proc/exe; retain exact argv, socket,
    // token and same-user checks rather than matching a broad process name.
    '    case "$phi_actual_exe" in "$phi_kernel_executable"|/run/rosetta/rosetta) ;; *) printf \'Cannot verify kernel executable: %s\\n\' "$phi_actual_exe" >&2; return 1 ;; esac',
    '    printf \'%s \' "$phi_pid"',
    '  done',
    '}',
    'phi_kernel_wait=0',
    'phi_kernel_live="$(phi_kernel_pids)" || exit 1',
    `while [ -n "$phi_kernel_live" ] && [ "$phi_kernel_wait" -lt ${GRACEFUL_SHUTDOWN_POLLS} ]; do`,
    '  sleep 0.1',
    '  phi_kernel_wait=$((phi_kernel_wait + 1))',
    '  phi_kernel_live="$(phi_kernel_pids)" || exit 1',
    'done',
    'if [ -n "$phi_kernel_live" ]; then',
    '  phi_kernel_cleanup=term',
    '  kill -TERM $phi_kernel_live 2>/dev/null || true',
    '  phi_kernel_wait=0',
    '  while [ -n "$phi_kernel_live" ] && [ "$phi_kernel_wait" -lt ' +
      `${FORCED_SHUTDOWN_POLLS} ]; do`,
    '    sleep 0.1',
    '    phi_kernel_wait=$((phi_kernel_wait + 1))',
    '    phi_kernel_live="$(phi_kernel_pids)" || exit 1',
    '  done',
    'fi',
    'if [ -n "$phi_kernel_live" ]; then',
    '  phi_kernel_cleanup=kill',
    '  kill -KILL $phi_kernel_live 2>/dev/null || true',
    '  sleep 0.1',
    '  phi_kernel_live="$(phi_kernel_pids)" || exit 1',
    'fi',
    'if [ -n "$phi_kernel_live" ]; then',
    '  printf \'kernel cleanup left live pid(s): %s\\n\' "$phi_kernel_live" >&2',
    '  exit 1',
    'fi',
    'rm -f -- "$phi_kernel_socket" "$phi_kernel_token"',
    'test ! -e "$phi_kernel_socket" && test ! -e "$phi_kernel_token" || exit 1',
    'printf \'PHI_KERNEL_CLEANUP=%s\\n\' "$phi_kernel_cleanup"'
  ].join('\n')
}

export async function shutdownSshScenarioKernel(options: {
  session: Pick<RemoteSshSession, 'openStdio'>
  launch: LaunchedRemoteKernel
}): Promise<'graceful' | 'term' | 'kill'> {
  let closeError: unknown
  try {
    await options.launch.close()
  } catch (error) {
    closeError = error
  }

  if (!options.session.openStdio) {
    throw new Error('Remote kernel cleanup requires helper stdio support', { cause: closeError })
  }
  const helperProcess = await options.session.openStdio(
    `${shellQuote(options.launch.helper.remotePath)} serve --root ${shellQuote(options.launch.deployment.runtimeRoot)}`
  )
  const helper = new HelperRpcClient(helperProcess)
  let result: CommandResult
  try {
    result = await helper.request<CommandResult>('exec.run', {
      command: ['/bin/sh', '-c', buildSshKernelShutdownCommand(options.launch)],
      cwd: options.launch.deployment.runtimeRoot,
      timeoutMs: 60_000,
      maxOutputBytes: 64 * 1024
    })
  } finally {
    await helper.close().catch(() => undefined)
  }
  if (result.code !== 0 || result.signal) {
    const reason = result.stderr.trim() || `exit ${String(result.code ?? result.signal)}`
    throw new Error(`Remote kernel cleanup failed: ${reason}`, { cause: closeError })
  }
  const mode = /^PHI_KERNEL_CLEANUP=(graceful|term|kill)\n$/.exec(result.stdout)?.[1]
  if (result.truncated || (mode !== 'graceful' && mode !== 'term' && mode !== 'kill')) {
    throw new Error('Remote kernel cleanup evidence missing or invalid')
  }
  return mode
}
