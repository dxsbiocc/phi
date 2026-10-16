import { normalizeRemoteRuntimeRoot } from '../remote-runtime-root'
import {
  resolveRemoteWorkspaceHostBinding,
  validRemoteAbsolutePath,
  type RemoteWorkspaceHostBinding
} from '../remote-workspace-boundary'
import { SshHost } from '../workspace-host/ssh-host'
import {
  HOST_CAPABILITY_FAST_PROBE_SCRIPT,
  parseHostCapabilityProbe
} from '../workspace-host/probe'
import { createRemoteRuntimeInputExec } from './input-exec'
import type { RemoteRuntimeWorkspace } from './types'

const REMOTE_RUNTIME_ROOT_RESOLUTION_TIMEOUT_MS = 30_000
const REMOTE_RUNTIME_PLATFORM_PROBE_TIMEOUT_MS = 10_000

export interface RemoteRuntimeTarget {
  runtimeSessionId: string
  sessionId: string
  projectId: string
  configuredRoot: string
  micromambaPath?: string
}

export async function openRemoteRuntimeWorkspace(
  target: RemoteRuntimeTarget,
  signal?: AbortSignal,
  resolveBinding: (input: {
    sessionId: string
    projectId: string
  }) => RemoteWorkspaceHostBinding = resolveRemoteWorkspaceHostBinding
): Promise<RemoteRuntimeWorkspace> {
  const binding = resolveBinding({ sessionId: target.sessionId, projectId: target.projectId })
  const execWithInput = createRemoteRuntimeInputExec(binding.config.connect)
  signal?.throwIfAborted()
  const result = await execWithInput(HOST_CAPABILITY_FAST_PROBE_SCRIPT, {
    signal,
    timeoutMs: REMOTE_RUNTIME_PLATFORM_PROBE_TIMEOUT_MS,
    maxOutputBytes: 64 * 1024
  })
  signal?.throwIfAborted()
  const profile = parseHostCapabilityProbe(result.stdout)
  if (
    result.code !== 0 ||
    result.terminationReason ||
    result.truncated ||
    profile.probe.state === 'unavailable' ||
    profile.platform.os === 'unknown' ||
    profile.platform.arch === 'unknown'
  ) {
    throw new Error('无法安全探测服务器系统与架构；请检查 SSH 连接后重试。')
  }
  // Only platform identity is needed here; fast detection grants no additional host capabilities.
  const platform = profile.platform
  const projectHost = new SshHost({ ...binding.config, platform })
  try {
    const runtimeRoot = await resolveRemoteRuntimeRoot(
      projectHost,
      binding,
      target.configuredRoot,
      signal
    )
    signal?.throwIfAborted()
    const runtimeHost = new SshHost({
      remoteRoot: runtimeRoot,
      canonicalRoot: runtimeRoot,
      connect: binding.config.connect,
      platform
    })
    return {
      projectHost,
      runtimeHost,
      projectRoot: binding.canonicalRoot,
      runtimeRoot,
      ...(target.micromambaPath ? { micromambaPath: target.micromambaPath } : {}),
      execWithInput,
      close: async () => {
        await Promise.all([projectHost.close(), runtimeHost.close()])
      }
    }
  } catch (error) {
    await projectHost.close().catch(() => undefined)
    throw error
  }
}

export async function resolveRemoteRuntimeRoot(
  host: SshHost,
  binding: RemoteWorkspaceHostBinding,
  configuredRoot: string,
  signal?: AbortSignal
): Promise<string> {
  const configured = normalizeRemoteRuntimeRoot(configuredRoot)
  const script = [
    'set -eu',
    'case "$1" in',
    '  /*) phi_root=$1 ;;',
    "  '~/'*) phi_root=${HOME:?}/${1#\\~/} ;;",
    '  *) exit 20 ;;',
    'esac',
    'CDPATH= cd -P -- "$phi_root"',
    'printf %s "$PWD"'
  ].join('\n')
  const result = await host.exec.run(['sh', '-c', script, 'phi-runtime-root', configured], {
    cwd: binding.canonicalRoot,
    signal,
    timeoutMs: REMOTE_RUNTIME_ROOT_RESOLUTION_TIMEOUT_MS,
    maxOutputBytes: 4096
  })
  const root = result.stdout.trim()
  if (result.terminationReason === 'timeout') {
    throw new Error('服务器响应慢，运行时根目录检查超时，请稍后重试。')
  }
  if (result.code !== 0 || !validRemoteAbsolutePath(root)) {
    throw new Error(
      '服务器运行时根目录不存在或无法安全解析；请在远程主机设置中检查该目录与 micromamba 安装。'
    )
  }
  return root
}
