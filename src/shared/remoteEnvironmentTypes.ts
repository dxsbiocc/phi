export const REMOTE_ENVIRONMENT_TOOL_IDS = ['nextflow', 'jupyter', 'micromamba', 'docker'] as const

export type RemoteEnvironmentToolId = (typeof REMOTE_ENVIRONMENT_TOOL_IDS)[number]

export type RemoteEnvironmentToolPaths = Partial<Record<RemoteEnvironmentToolId, string>>

export interface RemoteEnvironmentSettingInput {
  runtimeRoot?: string
  toolPaths?: RemoteEnvironmentToolPaths
}

export function remoteEnvironmentPathError(value: string, label = '路径'): string | null {
  const path = value.trim()
  if (!path) return null
  if (path.includes(String.fromCharCode(0)) || /[\r\n]/.test(path)) {
    return `${label}不能包含 NUL 或换行符`
  }
  if (!path.startsWith('/')) {
    return `${label}必须是绝对路径`
  }
  if (path.split('/').some((segment) => segment === '..')) {
    return `${label}不能包含 .. 路径段`
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
    const clean = normalizeRemotePath(path, `${id} 路径`)
    if (id === 'docker' && clean && !clean.endsWith('/docker')) {
      throw new Error('Docker 路径必须指向名为 docker 的可执行文件')
    }
    if (clean) normalized[id] = clean
  }
  return normalized
}
