export const DEFAULT_REMOTE_RUNTIME_ROOT = '~/.phi/runtime'

export type RemoteRuntimeRootSource = 'project' | 'host' | 'default'

export interface RemoteRuntimeRootResolution {
  source: RemoteRuntimeRootSource
  configured: string
}

export interface ResolveRemoteRuntimeRootInput {
  projectOverride?: string | null
  hostOverride?: string | null
}

function hasParentSegment(value: string): boolean {
  return value.split('/').some((segment) => segment === '..')
}

function trimTrailingSlashes(value: string): string {
  const trimmed = value.replace(/\/+$/, '')
  if (!trimmed) return '/'
  return trimmed === '~' ? '~/' : trimmed
}

export function normalizeRemoteRuntimeRoot(value: string): string {
  if (!value || /[\0\r\n]/.test(value)) {
    throw new Error('远程运行时根目录不能为空，也不能包含 NUL 或换行符')
  }
  if (!value.startsWith('/') && !value.startsWith('~/')) {
    throw new Error('远程运行时根目录必须是绝对路径或以 ~/ 开头')
  }
  if (hasParentSegment(value)) {
    throw new Error('远程运行时根目录不能包含 .. 路径段')
  }
  return trimTrailingSlashes(value)
}

export function resolveRemoteRuntimeRoot(
  input: ResolveRemoteRuntimeRootInput
): RemoteRuntimeRootResolution {
  if (input.projectOverride != null) {
    return { source: 'project', configured: normalizeRemoteRuntimeRoot(input.projectOverride) }
  }
  if (input.hostOverride != null) {
    return { source: 'host', configured: normalizeRemoteRuntimeRoot(input.hostOverride) }
  }
  return { source: 'default', configured: DEFAULT_REMOTE_RUNTIME_ROOT }
}
