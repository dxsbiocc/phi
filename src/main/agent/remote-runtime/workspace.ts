import { normalizeRemoteRuntimeRoot } from '../remote-runtime-root'
import {
  resolveRemoteWorkspaceHostBinding,
  validRemoteAbsolutePath,
  type RemoteWorkspaceHostBinding
} from '../remote-workspace-boundary'
import { SshHost } from '../workspace-host/ssh-host'
import { createRemoteRuntimeInputExec } from './input-exec'
import type { RemoteRuntimeWorkspace } from './types'

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
  const projectHost = new SshHost(binding.config)
  try {
    const runtimeRoot = await resolvedRuntimeRoot(
      projectHost,
      binding,
      target.configuredRoot,
      signal
    )
    const runtimeHost = new SshHost({
      remoteRoot: runtimeRoot,
      canonicalRoot: runtimeRoot,
      connect: binding.config.connect
    })
    return {
      projectHost,
      runtimeHost,
      projectRoot: binding.canonicalRoot,
      runtimeRoot,
      ...(target.micromambaPath ? { micromambaPath: target.micromambaPath } : {}),
      execWithInput: createRemoteRuntimeInputExec(binding.config.connect),
      close: async () => {
        await Promise.all([projectHost.close(), runtimeHost.close()])
      }
    }
  } catch (error) {
    await projectHost.close().catch(() => undefined)
    throw error
  }
}

async function resolvedRuntimeRoot(
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
    timeoutMs: 10_000,
    maxOutputBytes: 4096
  })
  const root = result.stdout.trim()
  if (result.code !== 0 || !validRemoteAbsolutePath(root)) {
    throw new Error(
      '服务器运行时根目录不存在或无法安全解析；请在远程主机设置中检查该目录与 micromamba 安装。'
    )
  }
  return root
}
