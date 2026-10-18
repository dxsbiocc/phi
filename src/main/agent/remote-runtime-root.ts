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
    throw new Error('Remote runtime root must not be empty or contain NUL or newline characters')
  }
  if (!value.startsWith('/') && !value.startsWith('~/')) {
    throw new Error('Remote runtime root must be an absolute path or start with ~/')
  }
  if (hasParentSegment(value)) {
    throw new Error('Remote runtime root must not contain .. path segments')
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
