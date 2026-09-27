import { posix } from 'node:path'

import { getProject, type Project } from '../projects'
import {
  getRemoteHostProfile,
  remoteConnectionConfigForProfile,
  type RemoteHostProfile
} from '../remote-hosts'
import { isRemotePathInside } from '../remote-path-containment'
import { listRemoteDirectoryEntries } from '../remote-workspace-read'
import { resolveRemotePathOnSession, validRemoteAbsolutePath } from '../remote-workspace-boundary'
import { getPhiAgentDir } from '../runtime-paths'
import { remoteWorkspaceUri } from '../../../shared/remoteWorkspacePath'
import type { WrapperResultDirectoryRequest } from '../../../shared/wrapperResultTypes'
import { connectRemoteSshSession, type RemoteSshSession } from './remote-ssh-session'
import { readWrapperRun } from './store'
import type { WrapperRun } from './types'

export interface AuthorizedWrapperResultPath {
  projectId: string
  hostProfileId: string
  runId: string
  hostAlias: string
  scope: 'run' | 'output'
  root: string
  path: string
}

export interface WrapperResultDependencies {
  agentDir?: string
  getProject?: (projectId: string) => Project | undefined
  getRun?: (runId: string, agentDir: string) => WrapperRun | undefined
  getHostProfile?: (hostProfileId: string, agentDir: string) => RemoteHostProfile | undefined
  connectImpl?: typeof connectRemoteSshSession
  signal?: AbortSignal
}

function checkedRequest(input: unknown): WrapperResultDirectoryRequest {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Wrapper 结果目录请求无效')
  }
  const request = input as Record<string, unknown>
  if (
    Object.keys(request).some(
      (key) => !['projectId', 'hostProfileId', 'runId', 'scope', 'path'].includes(key)
    ) ||
    typeof request.projectId !== 'string' ||
    !request.projectId ||
    typeof request.hostProfileId !== 'string' ||
    !request.hostProfileId ||
    typeof request.runId !== 'string' ||
    !/^wrun_[A-Za-z0-9_-]{1,128}$/.test(request.runId) ||
    (request.scope !== 'run' && request.scope !== 'output') ||
    (request.path !== undefined && typeof request.path !== 'string')
  ) {
    throw new Error('Wrapper 结果请求只能包含项目、服务器、运行 ID、范围和相对路径')
  }
  const path = request.path as string | undefined
  if (
    path &&
    (path.startsWith('/') ||
      path.startsWith('~/') ||
      /^ssh:\/\//i.test(path) ||
      path.split('/').includes('..') ||
      path.includes('\0') ||
      path.includes('\uFFFD') ||
      Buffer.byteLength(path, 'utf8') > 4096)
  ) {
    throw new Error('Wrapper 结果只能使用范围内的相对路径')
  }
  return request as unknown as WrapperResultDirectoryRequest
}

function checkedRoot(path: string | undefined, label: string): string {
  if (!path || !validRemoteAbsolutePath(path) || path.split('/').includes('..')) {
    throw new Error(`运行记录中的${label}无效`)
  }
  return posix.normalize(path)
}

function boundRoots(
  request: WrapperResultDirectoryRequest,
  run: WrapperRun,
  project: Project,
  profile: RemoteHostProfile
): { workspaceRoot: string; runRoot: string; outputRoot: string } {
  const saved = run.remote
  if (
    !saved ||
    run.runId !== request.runId ||
    saved.projectId !== request.projectId ||
    saved.hostProfileId !== request.hostProfileId ||
    saved.host !== profile.hostAlias
  ) {
    throw new Error('Wrapper 运行与项目或 SSH 服务器不匹配')
  }
  if (
    project.location.kind === 'ssh' &&
    (project.location.hostProfileId !== request.hostProfileId ||
      project.location.canonicalRoot !== saved.workspaceRoot)
  ) {
    throw new Error('远程项目的服务器或根目录已变化')
  }
  const workspaceRoot = checkedRoot(saved.workspaceRoot, '服务器工作根')
  const runRoot = checkedRoot(saved.runDir, '运行目录')
  const outputRoot = checkedRoot(saved.outputRoot, '输出目录')
  if (outputRoot === '/') throw new Error('不能将服务器根目录作为 Wrapper 输出范围')
  if (
    runRoot !== posix.join(workspaceRoot, 'wrappers', 'runs', run.runId) ||
    posix.normalize(run.outDir) !== outputRoot ||
    (!isRemotePathInside(workspaceRoot, outputRoot) && !saved.externalOutputAuthorized)
  ) {
    throw new Error('Wrapper 结果目录与提交时记录的授权范围不一致')
  }
  return { workspaceRoot, runRoot, outputRoot }
}

/** Authorize on the main process and keep the operation on the same SSH session. */
export async function withAuthorizedWrapperResultPath<T>(
  input: unknown,
  operation: (authorized: AuthorizedWrapperResultPath, session: RemoteSshSession) => Promise<T>,
  dependencies: WrapperResultDependencies = {}
): Promise<T> {
  const request = checkedRequest(input)
  dependencies.signal?.throwIfAborted()
  const agentDir = dependencies.agentDir ?? getPhiAgentDir()
  const run = (dependencies.getRun ?? readWrapperRun)(request.runId, agentDir)
  const project = (dependencies.getProject ?? getProject)(request.projectId)
  const profile = (dependencies.getHostProfile ?? getRemoteHostProfile)(
    request.hostProfileId,
    agentDir
  )
  if (!run || !project || !profile) throw new Error('Wrapper 运行、项目或服务器档案不可用')
  const { workspaceRoot, runRoot, outputRoot } = boundRoots(request, run, project, profile)
  const root = request.scope === 'run' ? runRoot : outputRoot
  const candidate = posix.resolve(root, request.path || '.')
  if (!isRemotePathInside(root, candidate)) throw new Error('Wrapper 结果路径超出授权范围')

  const session = await (dependencies.connectImpl ?? connectRemoteSshSession)({
    ...remoteConnectionConfigForProfile(profile),
    readyTimeoutMs: 10_000,
    execTimeoutMs: 30_000
  })
  try {
    dependencies.signal?.throwIfAborted()
    const physicalWorkspace = await resolveRemotePathOnSession(
      session,
      workspaceRoot,
      workspaceRoot,
      workspaceRoot,
      'existing',
      dependencies.signal
    )
    if (physicalWorkspace !== workspaceRoot) throw new Error('远端工作根发生了符号链接变化')
    const physicalRun = await resolveRemotePathOnSession(
      session,
      workspaceRoot,
      workspaceRoot,
      runRoot,
      'existing',
      dependencies.signal
    )
    if (physicalRun !== runRoot) throw new Error('远端运行目录发生了符号链接变化')
    if (request.scope === 'output') {
      const physicalOutput = await resolveRemotePathOnSession(
        session,
        workspaceRoot,
        workspaceRoot,
        outputRoot,
        'existing',
        dependencies.signal
      )
      if (physicalOutput !== outputRoot) throw new Error('远端输出目录发生了符号链接变化')
    }
    const path = await resolveRemotePathOnSession(
      session,
      workspaceRoot,
      workspaceRoot,
      candidate,
      'existing',
      dependencies.signal
    )
    if (!isRemotePathInside(root, path)) throw new Error('Wrapper 结果路径超出授权范围')
    dependencies.signal?.throwIfAborted()
    return await operation(
      {
        projectId: request.projectId,
        hostProfileId: request.hostProfileId,
        runId: request.runId,
        hostAlias: profile.hostAlias,
        scope: request.scope,
        root,
        path
      },
      session
    )
  } finally {
    await session.close().catch(() => undefined)
  }
}

/** Reuses T02's bounded directory listing; no second remote listing backend. */
export async function listWrapperResultDirectory(
  input: unknown,
  dependencies: WrapperResultDependencies = {}
): Promise<{
  path: string
  name: string
  displayPath: string
  rootPath: string
  rootLabel: string
  entries: Array<{ path: string; name: string; displayPath: string; kind: 'directory' | 'file' }>
  truncated: false
}> {
  return withAuthorizedWrapperResultPath(
    input,
    async (authorized, session) => {
      const entries = await listRemoteDirectoryEntries(session, authorized.path, authorized.root)
      return {
        path: remoteWorkspaceUri(authorized.hostAlias, authorized.path),
        name: posix.basename(authorized.path) || '/',
        displayPath: `${authorized.hostAlias}${authorized.path}`,
        rootPath: remoteWorkspaceUri(authorized.hostAlias, authorized.root),
        rootLabel: authorized.hostAlias,
        entries: entries.map((entry) => {
          const child = posix.join(authorized.path, entry.name)
          return {
            path: remoteWorkspaceUri(authorized.hostAlias, child),
            name: entry.name,
            displayPath: `${authorized.hostAlias}${child}`,
            kind: entry.isDirectory ? ('directory' as const) : ('file' as const)
          }
        }),
        truncated: false as const
      }
    },
    dependencies
  )
}
