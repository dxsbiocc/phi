import { normalizeRemoteRuntimeRoot } from '../remote-runtime-root'
import {
  resolveRemoteWorkspaceHostBinding,
  validRemoteAbsolutePath,
  type RemoteWorkspaceHostBinding
} from '../remote-workspace-boundary'
import { SshHost } from '../workspace-host/ssh-host'
import type { SshHelperBootstrapConfig } from '../workspace-host/ssh-host-context'
import {
  HOST_CAPABILITY_FAST_PROBE_SCRIPT,
  parseHostCapabilityProbe
} from '../workspace-host/probe'
import { shellQuote } from '../wrappers/remote-ssh-session'
import { createRemoteRuntimeInputExec } from './input-exec'
import type { RemoteRuntimeInputExec, RemoteRuntimeWorkspace } from './types'
import type { RemoteStartupDiagnostics } from '../engine/rpc/remote-startup-diagnostics'

const REMOTE_RUNTIME_ROOT_RESOLUTION_TIMEOUT_MS = 30_000
const REMOTE_RUNTIME_PLATFORM_PROBE_TIMEOUT_MS = 10_000

export interface RemoteRuntimeTarget {
  runtimeSessionId: string
  sessionId: string
  projectId: string
  configuredRoot: string
  micromambaPath?: string
}

/** Overrides for where the runtime host finds its helper; production passes none (same defaults as the registry). */
export type RemoteRuntimeHelperLocations = Pick<
  SshHelperBootstrapConfig,
  'agentDir' | 'resourceRoot' | 'developmentRoot'
>

export async function openRemoteRuntimeWorkspace(
  target: RemoteRuntimeTarget,
  signal?: AbortSignal,
  resolveBinding: (input: {
    sessionId: string
    projectId: string
  }) => RemoteWorkspaceHostBinding = resolveRemoteWorkspaceHostBinding,
  startupDiagnostics?: RemoteStartupDiagnostics,
  helperLocations: RemoteRuntimeHelperLocations = {}
): Promise<RemoteRuntimeWorkspace> {
  const binding = resolveBinding({ sessionId: target.sessionId, projectId: target.projectId })
  const execWithInput = createRemoteRuntimeInputExec(binding.config.connect)
  signal?.throwIfAborted()
  const result = await (startupDiagnostics?.step('platform_probe', () =>
    execWithInput(HOST_CAPABILITY_FAST_PROBE_SCRIPT, {
      signal,
      timeoutMs: REMOTE_RUNTIME_PLATFORM_PROBE_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024
    })
  ) ??
    execWithInput(HOST_CAPABILITY_FAST_PROBE_SCRIPT, {
      signal,
      timeoutMs: REMOTE_RUNTIME_PLATFORM_PROBE_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024
    }))
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
    const resolveRoot = (): Promise<string> =>
      resolveRemoteRuntimeRoot(execWithInput, target.configuredRoot, signal)
    const runtimeRoot = await (startupDiagnostics?.step('runtime_root', resolveRoot) ??
      resolveRoot())
    signal?.throwIfAborted()
    const runtimeHost = new SshHost({
      remoteRoot: runtimeRoot,
      canonicalRoot: runtimeRoot,
      connect: binding.config.connect,
      platform,
      // RPC startup runs the helper guard on this host, so it must be able to install the managed
      // helper exactly as the registry's hosts do. The project host never needs it.
      helperBootstrap: {
        profileKey: { hostAlias: binding.hostAlias, projectRoot: runtimeRoot },
        onDemand: true,
        ...helperLocations
      }
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

/**
 * Resolves the configured runtime root with ONE stdin-script command. It deliberately avoids the
 * project host's exec: that path launches a detached job (run directory, claim, launch script,
 * status polls, log reads, cleanup) and costs ~19 remote commands for a single `cd -P`.
 */
export async function resolveRemoteRuntimeRoot(
  execWithInput: RemoteRuntimeInputExec,
  configuredRoot: string,
  signal?: AbortSignal
): Promise<string> {
  const configured = normalizeRemoteRuntimeRoot(configuredRoot)
  const script = [
    'set -eu',
    `phi_configured=${shellQuote(configured)}`,
    'case "$phi_configured" in',
    '  /*) phi_root=$phi_configured ;;',
    "  '~/'*) phi_root=${HOME:?}/${phi_configured#\\~/} ;;",
    '  *) exit 20 ;;',
    'esac',
    'CDPATH= cd -P -- "$phi_root"',
    'printf %s "$PWD"',
    ''
  ].join('\n')
  const result = await execWithInput(script, {
    signal,
    timeoutMs: REMOTE_RUNTIME_ROOT_RESOLUTION_TIMEOUT_MS,
    maxOutputBytes: 4096
  })
  const root = result.stdout.trim()
  if (result.terminationReason === 'timeout') {
    throw new Error('服务器响应慢，运行时根目录检查超时，请稍后重试。')
  }
  if (result.code !== 0 || result.truncated || !validRemoteAbsolutePath(root)) {
    throw new Error(
      '服务器运行时根目录不存在或无法安全解析；请在远程主机设置中检查该目录与 micromamba 安装。'
    )
  }
  return root
}
