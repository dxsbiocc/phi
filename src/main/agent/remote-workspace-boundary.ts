import { posix, resolve } from 'node:path'

import type { Project } from './projects'
import { getProject } from './projects'
import {
  getRemoteHostProfile,
  remoteConnectionConfigForProfile,
  type RemoteHostProfile
} from './remote-hosts'
import { ensureRemoteProjectAnchor } from './remote-project-anchor'
import { getPhiAgentDir } from './runtime-paths'
import { isRemotePathInside } from './remote-path-containment'
import { findPhiSessionById, type PhiSessionManifest } from './session/session-store'
import {
  connectRemoteSshSession,
  shellQuote,
  type RemoteConnectionConfig,
  type RemoteSshSession
} from './wrappers/remote-ssh-session'

export type RemoteWorkspacePathMode = 'existing' | 'create'

/** Worker requests identify a Phi session/project, never an arbitrary SSH host. */
export interface RemoteWorkspacePathRequest {
  sessionId: string
  projectId: string
  path: string
  mode: RemoteWorkspacePathMode
}

export interface AuthorizedRemoteWorkspacePath {
  sessionId: string
  projectId: string
  hostAlias: string
  remoteRoot: string
  canonicalRoot: string
  path: string
  relativePath: string
  mode: RemoteWorkspacePathMode
}

export interface AuthorizedRemoteBashContext {
  sessionId: string
  projectId: string
  hostAlias: string
  cwd: string
  approvalScope: string
}

export function remoteBashApprovalScope(hostAlias: string, cwd: string): string {
  return `SSH ${hostAlias} · cwd ${cwd}；Shell 命令可访问项目目录之外，当前路径检查不是命令沙箱。`
}

export interface RemoteWorkspaceBoundaryDependencies {
  agentDir?: string
  execTimeoutMs?: number
  getManifest?: (sessionId: string) => PhiSessionManifest | null
  getProject?: (projectId: string) => Project | undefined
  getHostProfile?: (hostProfileId: string, agentDir: string) => RemoteHostProfile | undefined
  connectImpl?: (config: RemoteConnectionConfig) => Promise<RemoteSshSession>
  onConnected?: (session: RemoteSshSession) => void
}

export function validRemoteAbsolutePath(path: string): boolean {
  return (
    posix.isAbsolute(path) &&
    Buffer.byteLength(path, 'utf-8') <= 4096 &&
    !path.includes('\0') &&
    !path.includes('\uFFFD')
  )
}

function candidatePath(
  path: string,
  remoteRoot: string,
  canonicalRoot: string,
  mode: RemoteWorkspacePathMode
): string {
  if (
    !path ||
    Buffer.byteLength(path, 'utf-8') > 4096 ||
    path.includes('\0') ||
    /^ssh:\/\//i.test(path)
  ) {
    throw new Error('远程工作区路径无效；不能传入 ssh:// 地址')
  }
  if (path.split('/').includes('..') || path.startsWith('~/')) {
    throw new Error('远程工作区路径不能包含父目录跳转')
  }
  if (!validRemoteAbsolutePath(remoteRoot) || !validRemoteAbsolutePath(canonicalRoot)) {
    throw new Error('远程项目根目录无效')
  }
  const candidate = posix.isAbsolute(path) ? posix.normalize(path) : posix.join(remoteRoot, path)
  if (!validRemoteAbsolutePath(candidate)) throw new Error('远程工作区路径无效')
  if (!isRemotePathInside(remoteRoot, candidate) && !isRemotePathInside(canonicalRoot, candidate)) {
    throw new Error('远程路径不属于当前项目')
  }
  if (mode === 'create' && (candidate === remoteRoot || candidate === canonicalRoot)) {
    throw new Error('不能将项目根目录作为新文件')
  }
  return candidate
}

/** Only fixed Bash operations; no model-provided command is interpolated. */
export function buildRemoteWorkspaceResolveCommand(
  remoteRoot: string,
  canonicalRoot: string,
  candidate: string,
  mode: RemoteWorkspacePathMode
): string {
  const script = [
    'set -eu',
    `cd -P -- ${shellQuote(remoteRoot)} || exit 30`,
    `[ "$PWD" = ${shellQuote(canonicalRoot)} ] || exit 30`,
    `candidate=${shellQuote(candidate)}`,
    ...(mode === 'existing'
      ? [
          '[ -e "$candidate" ] || { [ ! -L "$candidate" ] || exit 32; exit 31; }',
          'if command -v realpath >/dev/null 2>&1; then',
          '  if realpath -z -- "$candidate" 2>/dev/null; then exit 0; fi',
          'fi',
          'command -v perl >/dev/null 2>&1 || exit 36',
          `perl -MCwd=realpath -e ${shellQuote('my $p = realpath($ARGV[0]); defined($p) or exit 1; print $p, "\\0";')} -- "$candidate" || exit 33`
        ]
      : [
          '[ ! -e "$candidate" ] && [ ! -L "$candidate" ] || exit 34',
          'parent=${candidate%/*}',
          'leaf=${candidate##*/}',
          '[ -n "$leaf" ] || exit 35',
          'cd -P -- "$parent" || exit 35',
          'parent_real=$PWD',
          '[ "$parent" -ef "$parent_real" ] || exit 35',
          `if [ "$parent_real" = / ]; then printf '/%s\\0' "$leaf"; else printf '%s/%s\\0' "$parent_real" "$leaf"; fi`
        ])
  ].join('\n')
  return `bash -c ${shellQuote(script)}`
}

function checkedRequest(value: unknown): RemoteWorkspacePathRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('远程工作区请求无效')
  }
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).some((key) => !['sessionId', 'projectId', 'path', 'mode'].includes(key)) ||
    typeof record.sessionId !== 'string' ||
    !record.sessionId ||
    typeof record.projectId !== 'string' ||
    !record.projectId ||
    typeof record.path !== 'string' ||
    (record.mode !== 'existing' && record.mode !== 'create')
  ) {
    throw new Error('远程工作区请求只能包含会话、项目、路径和操作类型')
  }
  return record as unknown as RemoteWorkspacePathRequest
}

function boundProject(
  request: RemoteWorkspacePathRequest,
  dependencies: RemoteWorkspaceBoundaryDependencies,
  agentDir: string
): { project: Project; profile: RemoteHostProfile } {
  const manifest = (dependencies.getManifest ?? findPhiSessionById)(request.sessionId)
  const project = (dependencies.getProject ?? getProject)(request.projectId)
  if (
    !manifest ||
    !project ||
    manifest.kind !== 'project' ||
    manifest.projectId !== request.projectId ||
    manifest.projectLocation?.kind !== 'ssh' ||
    project.location.kind !== 'ssh' ||
    resolve(manifest.cwd) !== resolve(ensureRemoteProjectAnchor(request.projectId, agentDir)) ||
    manifest.projectLocation.hostProfileId !== project.location.hostProfileId ||
    manifest.projectLocation.canonicalRoot !== project.location.canonicalRoot ||
    manifest.projectLocation.remoteRoot !== project.location.remoteRoot
  ) {
    throw new Error('远程工作区会话与项目不匹配')
  }
  const profile = (dependencies.getHostProfile ?? getRemoteHostProfile)(
    project.location.hostProfileId,
    agentDir
  )
  if (!profile) throw new Error('远程项目的 SSH 服务器档案不可用')
  return { project, profile }
}

const RESOLVE_ERRORS: Record<number, string> = {
  30: '项目根目录已变化或不可访问',
  31: '目标不存在',
  32: '目标是悬空符号链接',
  33: '目标无法安全规范化',
  34: '新建目标已存在或是符号链接',
  35: '新建目标的父目录不可访问',
  36: '服务器缺少路径规范化命令'
}

/** T01's server-side realpath check, reusable for a run-scoped result root. */
export async function resolveRemotePathOnSession(
  session: RemoteSshSession,
  remoteRoot: string,
  canonicalRoot: string,
  candidate: string,
  mode: RemoteWorkspacePathMode = 'existing',
  signal?: AbortSignal
): Promise<string> {
  if (
    !validRemoteAbsolutePath(remoteRoot) ||
    !validRemoteAbsolutePath(canonicalRoot) ||
    !validRemoteAbsolutePath(candidate)
  ) {
    throw new Error('远程路径授权参数无效')
  }
  signal?.throwIfAborted()
  const command = buildRemoteWorkspaceResolveCommand(remoteRoot, canonicalRoot, candidate, mode)
  const result =
    signal && session.execBounded
      ? await session.execBounded(command, {
          timeoutMs: 30_000,
          maxOutputBytes: 8192,
          signal
        })
      : await session.exec(command)
  signal?.throwIfAborted()
  if (
    ('stdoutTruncated' in result && result.stdoutTruncated) ||
    ('stderrTruncated' in result && result.stderrTruncated)
  ) {
    throw new Error('远程路径授权返回超过上限')
  }
  if (result.code !== 0) {
    if (result.code === 31) throw new RemoteWorkspaceTargetMissingError()
    throw new Error(`远程路径授权失败：${RESOLVE_ERRORS[result.code ?? -1] ?? '远程检查未完成'}`)
  }
  const nul = result.stdout.indexOf('\0')
  if (nul !== result.stdout.length - 1 || nul < 1) {
    throw new Error('远程路径授权返回格式无效')
  }
  const path = posix.normalize(result.stdout.slice(0, nul))
  if (!validRemoteAbsolutePath(path)) throw new Error('远程路径授权返回格式无效')
  return path
}

export class RemoteWorkspaceTargetMissingError extends Error {
  constructor() {
    super('远程路径授权失败：目标不存在')
  }
}

/** Keeps authorization and the following operation on the same SSH session. */
export async function withAuthorizedRemoteWorkspacePath<T>(
  input: unknown,
  operation: (authorized: AuthorizedRemoteWorkspacePath, session: RemoteSshSession) => Promise<T>,
  dependencies: RemoteWorkspaceBoundaryDependencies = {}
): Promise<T> {
  const request = checkedRequest(input)
  const agentDir = dependencies.agentDir ?? getPhiAgentDir()
  const { project, profile } = boundProject(request, dependencies, agentDir)
  if (project.location.kind !== 'ssh') throw new Error('远程项目位置无效')
  const { remoteRoot, canonicalRoot } = project.location
  const candidate = candidatePath(request.path, remoteRoot, canonicalRoot, request.mode)
  const connect = dependencies.connectImpl ?? connectRemoteSshSession
  const session = await connect({
    ...remoteConnectionConfigForProfile(profile),
    readyTimeoutMs: 10_000,
    execTimeoutMs: dependencies.execTimeoutMs ?? 10_000
  })
  try {
    dependencies.onConnected?.(session)
    const path = await resolveRemotePathOnSession(
      session,
      remoteRoot,
      canonicalRoot,
      candidate,
      request.mode
    )
    if (!isRemotePathInside(canonicalRoot, path)) {
      throw new Error('远程路径超出项目根目录')
    }
    const authorized: AuthorizedRemoteWorkspacePath = {
      sessionId: request.sessionId,
      projectId: request.projectId,
      hostAlias: profile.hostAlias,
      remoteRoot,
      canonicalRoot,
      path,
      relativePath: posix.relative(canonicalRoot, path),
      mode: request.mode
    }
    return await operation(authorized, session)
  } finally {
    await session.close()
  }
}

export async function resolveRemoteWorkspacePath(
  input: unknown,
  dependencies: RemoteWorkspaceBoundaryDependencies = {}
): Promise<AuthorizedRemoteWorkspacePath> {
  return withAuthorizedRemoteWorkspacePath(input, async (authorized) => authorized, dependencies)
}

/** Shell cwd is the verified project root; shell commands themselves are not a file sandbox. */
export async function resolveRemoteBashContext(
  input: unknown,
  dependencies: RemoteWorkspaceBoundaryDependencies = {}
): Promise<AuthorizedRemoteBashContext> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('远程命令请求无效')
  }
  const record = input as Record<string, unknown>
  if (
    Object.keys(record).some((key) => !['sessionId', 'projectId'].includes(key)) ||
    typeof record.sessionId !== 'string' ||
    typeof record.projectId !== 'string'
  ) {
    throw new Error('远程命令请求只能包含会话和项目 ID')
  }
  const authorized = await resolveRemoteWorkspacePath(
    { sessionId: record.sessionId, projectId: record.projectId, path: '.', mode: 'existing' },
    dependencies
  )
  return {
    sessionId: authorized.sessionId,
    projectId: authorized.projectId,
    hostAlias: authorized.hostAlias,
    cwd: authorized.canonicalRoot,
    approvalScope: remoteBashApprovalScope(authorized.hostAlias, authorized.canonicalRoot)
  }
}
