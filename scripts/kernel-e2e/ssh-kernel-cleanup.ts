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

/**
 * Close the controller first so the kernel's normal disconnect grace path can
 * dispose sessions and remove its socket. The fallback is deliberately tied to
 * both the verified executable and this deployment's exact socket argument.
 */
export function buildSshKernelShutdownCommand(launch: LaunchedRemoteKernel): string {
  const identity = kernelSocketIdentity(launch.deployment)
  const { stem } = deriveKernelSocketPaths(launch.deployment.runtimeRoot, identity, 0)
  const executable = shellQuote(launch.deployment.executablePath)
  const quotedStem = shellQuote(stem)

  return [
    'phi_kernel_dir="/tmp/phi-k-$(id -u)"',
    `phi_kernel_stem=${quotedStem}`,
    'phi_kernel_socket="$phi_kernel_dir/$phi_kernel_stem.sock"',
    'phi_kernel_token="$phi_kernel_dir/$phi_kernel_stem.token"',
    `phi_kernel_executable=${executable}`,
    'phi_kernel_pids() {',
    // Only this user's processes: a full /proc scan per poll is too slow on busy cluster nodes.
    '  for phi_pid in $(ps -u "$(id -u)" -o pid=); do',
    '    phi_proc="/proc/$phi_pid"',
    '    [ "$(readlink "$phi_proc/exe" 2>/dev/null)" = "$phi_kernel_executable" ] || continue',
    '    if tr \'\\000\' \'\\n\' < "$phi_proc/cmdline" 2>/dev/null | grep -Fqx -- "$phi_kernel_socket"; then',
    '      printf \'%s \' "${phi_proc##*/}"',
    '    fi',
    '  done',
    '}',
    'phi_kernel_wait=0',
    'phi_kernel_live="$(phi_kernel_pids)"',
    `while [ -n "$phi_kernel_live" ] && [ "$phi_kernel_wait" -lt ${GRACEFUL_SHUTDOWN_POLLS} ]; do`,
    '  sleep 0.1',
    '  phi_kernel_wait=$((phi_kernel_wait + 1))',
    '  phi_kernel_live="$(phi_kernel_pids)"',
    'done',
    'if [ -n "$phi_kernel_live" ]; then',
    '  kill -TERM $phi_kernel_live 2>/dev/null || true',
    '  phi_kernel_wait=0',
    '  while [ -n "$phi_kernel_live" ] && [ "$phi_kernel_wait" -lt ' +
      `${FORCED_SHUTDOWN_POLLS} ]; do`,
    '    sleep 0.1',
    '    phi_kernel_wait=$((phi_kernel_wait + 1))',
    '    phi_kernel_live="$(phi_kernel_pids)"',
    '  done',
    'fi',
    'if [ -n "$phi_kernel_live" ]; then',
    '  kill -KILL $phi_kernel_live 2>/dev/null || true',
    '  sleep 0.1',
    '  phi_kernel_live="$(phi_kernel_pids)"',
    'fi',
    'if [ -n "$phi_kernel_live" ]; then',
    '  printf \'kernel cleanup left live pid(s): %s\\n\' "$phi_kernel_live" >&2',
    '  exit 1',
    'fi',
    'rm -f -- "$phi_kernel_socket" "$phi_kernel_token"',
    'test ! -e "$phi_kernel_socket" && test ! -e "$phi_kernel_token"'
  ].join('\n')
}

export async function shutdownSshScenarioKernel(options: {
  session: Pick<RemoteSshSession, 'openStdio'>
  launch: LaunchedRemoteKernel
}): Promise<void> {
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
}
