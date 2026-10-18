export const REMOTE_ENVIRONMENT_TOOL_IDS = ['nextflow', 'jupyter', 'micromamba', 'docker'] as const

export type RemoteEnvironmentToolId = (typeof REMOTE_ENVIRONMENT_TOOL_IDS)[number]

export type RemoteEnvironmentToolPaths = Partial<Record<RemoteEnvironmentToolId, string>>

export interface RemoteEnvironmentSettingInput {
  runtimeRoot?: string
  toolPaths?: RemoteEnvironmentToolPaths
}

export function remoteEnvironmentPathError(value: string, label = 'Path'): string | null {
  const path = value.trim()
  if (!path) return null
  if (path.includes(String.fromCharCode(0)) || /[\r\n]/.test(path)) {
    return `${label} must not contain NUL or newline characters`
  }
  if (!path.startsWith('/')) {
    return `${label} must be an absolute path`
  }
  if (path.split('/').some((segment) => segment === '..')) {
    return `${label} must not contain .. path segments`
  }
  return null
}

function normalizeRemotePath(value: string, label: string): string | undefined {
  const path = value.trim()
  if (!path) return undefined
  const error = remoteEnvironmentPathError(path, label)
  if (error) throw new Error(error)
  return path === '/' ? path : path.replace(/\/+$/, '')
}

export function normalizeRemoteEnvironmentToolPaths(
  value: RemoteEnvironmentToolPaths | null | undefined
): RemoteEnvironmentToolPaths {
  const normalized: RemoteEnvironmentToolPaths = {}
  for (const id of REMOTE_ENVIRONMENT_TOOL_IDS) {
    const path = value?.[id]
    if (path === undefined) continue
    const clean = normalizeRemotePath(path, `${id} path`)
    if (id === 'docker' && clean && !clean.endsWith('/docker')) {
      throw new Error('Docker path must point to an executable named docker')
    }
    if (clean) normalized[id] = clean
  }
  return normalized
}
