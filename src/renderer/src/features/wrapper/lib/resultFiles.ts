import type { WrapperRun, WrapperOutputRecord } from '../../../../../shared/wrapperTypes'
import type { WrapperResultDirectoryRequest } from '../../../../../shared/wrapperResultTypes'
import {
  remotePathInsideRoot,
  remotePathWithinProjectUri,
  remoteWorkspaceUri
} from '../../../../../shared/remoteWorkspacePath'

export interface WrapperResultFileScope {
  projectId: string
  hostProfileId: string
  runId: string
  hostAlias: string
  scope: 'run' | 'output'
  root: string
}

export function wrapperResultScopeChanged(
  current: WrapperResultFileScope | null,
  next: WrapperResultFileScope
): boolean {
  return (
    !current ||
    current.projectId !== next.projectId ||
    current.runId !== next.runId ||
    current.hostProfileId !== next.hostProfileId ||
    current.scope !== next.scope
  )
}

export function wrapperResultBelongsToProject(
  scope: WrapperResultFileScope | null,
  projectId: string | null
): boolean {
  return Boolean(scope && scope.projectId === projectId)
}

export function wrapperResultScopeForRun(
  run: WrapperRun,
  scope: WrapperResultFileScope['scope']
): WrapperResultFileScope | null {
  const remote = run.remote
  const root = scope === 'output' ? remote?.outputRoot : remote?.runDir
  if (
    !remote?.projectId ||
    !remote.hostProfileId ||
    !remote.host ||
    !root ||
    !root.startsWith('/')
  ) {
    return null
  }
  return {
    projectId: remote.projectId,
    hostProfileId: remote.hostProfileId,
    runId: run.runId,
    hostAlias: remote.host,
    scope,
    root
  }
}

export function wrapperResultScopeForOutput(
  run: WrapperRun,
  output: WrapperOutputRecord
): WrapperResultFileScope | null {
  if (output.location !== 'remote' || !output.exists) return null
  return wrapperResultScopeForPath(run, output.path)
}

export function wrapperResultScopeForPath(
  run: WrapperRun,
  path: string
): WrapperResultFileScope | null {
  for (const scope of ['output', 'run'] as const) {
    const candidate = wrapperResultScopeForRun(run, scope)
    if (candidate && remotePathInsideRoot(path, candidate.root)) return candidate
  }
  return null
}

export function wrapperResultUri(scope: WrapperResultFileScope, path = scope.root): string {
  if (!remotePathInsideRoot(path, scope.root)) {
    throw new Error('Wrapper 结果路径不属于该运行的授权范围')
  }
  return remoteWorkspaceUri(scope.hostAlias, path)
}

export function wrapperResultRequestForUri(
  uri: string,
  scope: WrapperResultFileScope
): WrapperResultDirectoryRequest {
  const path = remotePathWithinProjectUri(uri, scope.hostAlias, scope.root)
  if (!path) throw new Error('Wrapper 结果不属于当前运行或服务器')
  return {
    projectId: scope.projectId,
    hostProfileId: scope.hostProfileId,
    runId: scope.runId,
    scope: scope.scope,
    path: path === scope.root ? '' : path.slice(scope.root.length + 1)
  }
}

export function wrapperResultUriInScope(
  uri: string,
  scope: WrapperResultFileScope | null
): boolean {
  return Boolean(scope && remotePathWithinProjectUri(uri, scope.hostAlias, scope.root))
}
