import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { basename, join, posix, resolve } from 'node:path'
import type {
  ProjectLocation,
  RemoteProjectConnectionState,
  RemoteProjectReachability
} from '../../shared/projectLocation'
import type { RemoteHpcSettings } from '../../shared/wrapperRemoteTypes'
import type { WrapperInputPathMapping } from '../../shared/wrapperTypes'
import { getRemoteHostProfile, remoteConnectionConfigForProfile } from './remote-hosts'
import { getPhiAgentDir } from './runtime-paths'
import type { ConnectImpl } from './wrappers/executor-remote'
import { validateInputPathMapping } from './wrappers/path-mapping'
import { connectRemoteSshSession, shellQuote } from './wrappers/remote-ssh-session'

const PROJECTS_FILE = 'projects.json'
const remoteConnectionByProjectId = new Map<string, RemoteProjectConnectionState>()
const remoteConnectionListeners = new Set<
  (projectId: string, state: RemoteProjectConnectionState) => void
>()

export type PermissionMode = 'auto' | 'ask' | 'full'
export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface ModelSelection {
  providerId: string
  modelId: string
}

export interface ProjectGitStatus {
  branch: string
  dirty: boolean
}

/**
 * Per-wrapper defaults for a project. Phase 1 only ever populates
 * version/params/resources; `executor`/`profile` stay "local" and the
 * remote-connection fields below stay unset until Phase 2. The full shape is
 * modeled now (see docs/design/phi-wrapper-technical-design.md, Storage) so
 * this doesn't need a breaking change once Phase 2 remote defaults exist.
 */
export interface ProjectWrapperDefault {
  version?: string
  executor?: string
  profile?: string
  params?: Record<string, unknown>
  resources?: {
    cpus?: number
    memory?: string
    time?: string
  }
}

/** Project-specific HPC settings bound to a Phi-owned OpenSSH host profile. */
export interface ProjectRemoteConnection {
  id: string
  label: string
  hostProfileId: string
  hpc?: RemoteHpcSettings
  inputPathMapping?: WrapperInputPathMapping
}

export interface Project {
  id: string
  name: string
  location: ProjectLocation
  /** Legacy local-project display fields. For SSH projects these contain remote paths only. */
  workingDirectory: string
  workingDirectoryRealPath: string
  permissionMode: PermissionMode
  pathAvailable: boolean
  remoteReachability?: RemoteProjectReachability
  remoteConnection?: RemoteProjectConnectionState
  remoteHostAlias?: string
  defaultModel?: ModelSelection
  defaultThinkingLevel?: ThinkingLevel
  gitStatus?: ProjectGitStatus
  createdAt: string
  wrapperDefaults?: Record<string, ProjectWrapperDefault>
  /** Saved SSH targets this project can submit `slurm-controller`/remote wrapper runs to. */
  remoteConnections?: ProjectRemoteConnection[]
  /** Which `remoteConnections[].id` `runs.ts` uses when a submit doesn't specify one explicitly. */
  defaultRemoteConnectionId?: string
  /** Remote root Phi run directories are created under, e.g. `/data/lab/.phi`. */
  remoteWorkspaceRoot?: string
}

function getProjectsPath(): string {
  return join(getPhiAgentDir(), PROJECTS_FILE)
}

function ensureDir(): void {
  const phiDir = getPhiAgentDir()
  if (!existsSync(phiDir)) {
    mkdirSync(phiDir, { recursive: true })
  }
}

function resolveProjectRealPath(workingDirectory: string): string {
  try {
    return realpathSync(workingDirectory)
  } catch {
    throw new Error('项目路径不可用')
  }
}

function normalizeProjectAvailability(project: Project): Project {
  if (project.location.kind === 'ssh') {
    const profile = getRemoteHostProfile(project.location.hostProfileId)
    const connection = profile
      ? (remoteConnectionByProjectId.get(project.id) ?? { phase: 'unchecked' as const })
      : {
          phase: 'configuration_failed' as const,
          message: 'SSH 服务器档案不可用',
          suggestion: '在远程设置中恢复服务器档案后重试。'
        }
    return {
      ...project,
      // This legacy flag describes local filesystem paths; remote reachability is separate.
      pathAvailable: true,
      remoteReachability: connection.phase,
      remoteConnection: connection,
      remoteHostAlias: profile?.hostAlias,
      gitStatus: undefined
    }
  }
  try {
    const realPath = realpathSync(project.location.path)
    return {
      ...project,
      location: { ...project.location, realPath },
      workingDirectoryRealPath: realPath,
      pathAvailable: true
    }
  } catch {
    return {
      ...project,
      pathAvailable: false,
      gitStatus: undefined
    }
  }
}

function withProjectLocation(project: Project): Project {
  if (project.location?.kind === 'ssh' || project.location?.kind === 'local') return project
  return {
    ...project,
    location: {
      kind: 'local',
      path: project.workingDirectory,
      realPath: project.workingDirectoryRealPath
    }
  }
}

function readProjects(): Project[] {
  const projectsPath = getProjectsPath()
  if (!existsSync(projectsPath)) {
    return []
  }
  try {
    const raw = JSON.parse(readFileSync(projectsPath, 'utf-8'))
    return Array.isArray(raw) ? raw.map((project) => withProjectLocation(project as Project)) : []
  } catch {
    return []
  }
}

function writeProjects(projects: Project[]): void {
  ensureDir()
  writeFileSync(getProjectsPath(), JSON.stringify(projects, null, 2), 'utf-8')
}

function gitOutput(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return null
  }
}

export function readProjectGitStatus(workingDirectory: string): ProjectGitStatus | undefined {
  if (gitOutput(workingDirectory, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
    return undefined
  }

  const branch =
    gitOutput(workingDirectory, ['branch', '--show-current']) ||
    gitOutput(workingDirectory, ['rev-parse', '--short', 'HEAD']) ||
    'detached'
  const status = gitOutput(workingDirectory, ['status', '--porcelain'])

  return {
    branch,
    dirty: Boolean(status)
  }
}

/** Local project directories the user already added. Does not read Git status. */
export function listLocalProjectAllowRoots(): string[] {
  const roots: string[] = []
  for (const stored of readProjects()) {
    if (stored.location.kind !== 'local') continue
    const project = normalizeProjectAvailability(stored)
    if (!project.pathAvailable) continue
    roots.push(project.workingDirectory)
    if (
      project.workingDirectoryRealPath &&
      project.workingDirectoryRealPath !== project.workingDirectory
    ) {
      roots.push(project.workingDirectoryRealPath)
    }
  }
  return roots
}

export function listProjects(): Project[] {
  return readProjects()
    .map(normalizeProjectAvailability)
    .map((project) => ({
      ...project,
      gitStatus:
        project.location.kind === 'local' && project.pathAvailable
          ? readProjectGitStatus(project.workingDirectory)
          : undefined
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function getProject(id: string): Project | undefined {
  return readProjects().find((project) => project.id === id)
}

export function getProjectByCwd(cwd: string): Project | undefined {
  const projects = readProjects()
  const localProjects = projects.filter((project) => project.location.kind === 'local')
  const exact = localProjects.find((project) => project.workingDirectory === cwd)
  if (exact) return exact
  if (
    projects.some(
      (project) => project.location.kind === 'ssh' && project.location.remoteRoot === cwd
    )
  ) {
    return undefined
  }
  let realPath: string | undefined
  try {
    realPath = realpathSync(cwd)
  } catch {
    realPath = undefined
  }

  return localProjects.find(
    (project) => realPath !== undefined && project.workingDirectoryRealPath === realPath
  )
}

export function assertProjectPathAvailable(workingDirectory: string): void {
  const projects = readProjects()
  const project = projects.find(
    (item) => item.location.kind === 'local' && item.workingDirectory === workingDirectory
  )
  if (project && !normalizeProjectAvailability(project).pathAvailable) {
    throw new Error('项目路径不可用，请移除或重新添加该项目')
  }
  if (
    !project &&
    projects.some(
      (item) => item.location.kind === 'ssh' && item.location.remoteRoot === workingDirectory
    )
  ) {
    throw new Error('远程项目不能作为本地目录打开')
  }
}

export function updateProjectPermissionMode(id: string, permissionMode: PermissionMode): Project {
  const projects = readProjects()
  const index = projects.findIndex((project) => project.id === id)
  if (index < 0) {
    throw new Error('项目不存在')
  }

  const project = { ...projects[index], permissionMode }
  projects[index] = project
  writeProjects(projects)
  return normalizeProjectAvailability(project)
}

export function updateProjectDefaults(
  id: string,
  defaults: {
    defaultModel?: ModelSelection | null
    defaultThinkingLevel?: ThinkingLevel | null
  }
): Project {
  const projects = readProjects()
  const index = projects.findIndex((project) => project.id === id)
  if (index < 0) {
    throw new Error('项目不存在')
  }

  const project = { ...projects[index] }
  if (defaults.defaultModel !== undefined) {
    if (defaults.defaultModel === null) delete project.defaultModel
    else project.defaultModel = defaults.defaultModel
  }
  if (defaults.defaultThinkingLevel !== undefined) {
    if (defaults.defaultThinkingLevel === null) delete project.defaultThinkingLevel
    else project.defaultThinkingLevel = defaults.defaultThinkingLevel
  }
  projects[index] = project
  writeProjects(projects)
  return normalizeProjectAvailability(project)
}

export function createProject(input: {
  name: string
  workingDirectory: string
  permissionMode: PermissionMode
}): Project {
  const workingDirectoryRealPath = resolveProjectRealPath(input.workingDirectory)
  const projects = readProjects()
  if (
    projects.some(
      (project) =>
        project.location.kind === 'local' &&
        project.workingDirectoryRealPath === workingDirectoryRealPath
    )
  ) {
    throw new Error('项目已存在')
  }

  const project: Project = {
    id: randomUUID(),
    name: input.name.trim() || basename(input.workingDirectory) || '未命名项目',
    location: {
      kind: 'local',
      path: input.workingDirectory,
      realPath: workingDirectoryRealPath
    },
    workingDirectory: input.workingDirectory,
    workingDirectoryRealPath,
    permissionMode: input.permissionMode,
    pathAvailable: true,
    createdAt: new Date().toISOString()
  }
  projects.push(project)
  writeProjects(projects)
  return project
}

/** Canonicalize on the server; a remote path must never enter local realpath or Git operations. */
export async function createRemoteProject(
  input: {
    name: string
    hostProfileId: string
    remoteRoot: string
    permissionMode: PermissionMode
  },
  options: { connectImpl?: ConnectImpl } = {}
): Promise<Project> {
  const profile = getRemoteHostProfile(input.hostProfileId)
  if (!profile) throw new Error('SSH 服务器档案不存在')
  const remoteRoot = input.remoteRoot
  if (!remoteRoot.startsWith('/') || /[\r\n\0]/.test(remoteRoot)) {
    throw new Error('远程项目目录必须是服务器上的绝对路径')
  }
  const session = await (options.connectImpl ?? connectRemoteSshSession)({
    ...remoteConnectionConfigForProfile(profile)
  })
  let canonicalRoot: string
  try {
    const result = await session.exec(`cd ${shellQuote(remoteRoot)} && pwd -P`)
    canonicalRoot = result.stdout.replace(/\r?\n$/, '')
    if (result.code !== 0 || !canonicalRoot.startsWith('/') || /[\r\n\0]/.test(canonicalRoot)) {
      throw new Error('无法在服务器上确认项目目录')
    }
  } finally {
    await session.close()
  }
  canonicalRoot = posix.normalize(canonicalRoot)
  const projects = readProjects()
  if (
    projects.some(
      (project) =>
        project.location.kind === 'ssh' &&
        project.location.hostProfileId === input.hostProfileId &&
        project.location.canonicalRoot === canonicalRoot
    )
  ) {
    throw new Error('该服务器上的项目目录已存在')
  }

  const project: Project = {
    id: randomUUID(),
    name: input.name.trim() || posix.basename(canonicalRoot) || '未命名项目',
    location: {
      kind: 'ssh',
      hostProfileId: input.hostProfileId,
      remoteRoot,
      canonicalRoot
    },
    workingDirectory: remoteRoot,
    workingDirectoryRealPath: canonicalRoot,
    permissionMode: input.permissionMode,
    pathAvailable: true,
    createdAt: new Date().toISOString()
  }
  projects.push(project)
  writeProjects(projects)
  setRemoteProjectConnectionState(project.id, { phase: 'reachable' })
  return normalizeProjectAvailability(project)
}

export function setRemoteProjectConnectionState(
  id: string,
  state: RemoteProjectConnectionState
): void {
  const project = getProject(id)
  if (!project || project.location.kind !== 'ssh') throw new Error('远程项目不存在')
  remoteConnectionByProjectId.set(id, state)
  for (const listener of remoteConnectionListeners) {
    try {
      listener(id, state)
    } catch {
      // A status observer must not change a file or command operation's result.
    }
  }
}

export function subscribeRemoteProjectConnection(
  listener: (projectId: string, state: RemoteProjectConnectionState) => void
): () => void {
  remoteConnectionListeners.add(listener)
  return () => remoteConnectionListeners.delete(listener)
}

export function renameProject(id: string, name: string): Project {
  const projects = readProjects()
  const index = projects.findIndex((project) => project.id === id)
  if (index < 0) throw new Error('项目不存在')
  const trimmed = name.trim()
  if (!trimmed) throw new Error('项目名称不能为空')
  const updated = { ...projects[index], name: trimmed }
  projects[index] = updated
  writeProjects(projects)
  return updated
}

export function updateProjectWrapperDefault(
  id: string,
  wrapperCanonicalId: string,
  patch: ProjectWrapperDefault | null
): Project {
  const projects = readProjects()
  const index = projects.findIndex((project) => project.id === id)
  if (index < 0) {
    throw new Error('项目不存在')
  }

  const project = { ...projects[index] }
  const wrapperDefaults = { ...(project.wrapperDefaults ?? {}) }
  if (patch === null) {
    delete wrapperDefaults[wrapperCanonicalId]
  } else {
    wrapperDefaults[wrapperCanonicalId] = {
      ...wrapperDefaults[wrapperCanonicalId],
      ...patch
    }
  }
  project.wrapperDefaults = wrapperDefaults
  projects[index] = project
  writeProjects(projects)
  return project
}

/** Adds or replaces one project binding to an OpenSSH host profile. */
export function updateProjectRemoteConnection(
  id: string,
  connectionId: string,
  patch: ProjectRemoteConnection | null
): Project {
  const projects = readProjects()
  const index = projects.findIndex((project) => project.id === id)
  if (index < 0) {
    throw new Error('项目不存在')
  }

  const project = { ...projects[index] }
  const remoteConnections = (project.remoteConnections ?? []).filter(
    (connection) => connection.id !== connectionId
  )
  if (patch !== null) {
    if (!getRemoteHostProfile(patch.hostProfileId)) {
      throw new Error('所选 SSH 服务器档案不存在，请先添加服务器')
    }
    if (patch.inputPathMapping) {
      if (project.location.kind !== 'local') {
        throw new Error('远程项目不能配置本机输入路径映射')
      }
      const mappingErrors = validateInputPathMapping(patch.inputPathMapping)
      if (mappingErrors.length > 0) throw new Error(mappingErrors.join('；'))
    }
    remoteConnections.push({
      ...patch,
      ...(patch.inputPathMapping
        ? {
            inputPathMapping: {
              localRoot: resolve(patch.inputPathMapping.localRoot),
              remoteRoot: posix.normalize(patch.inputPathMapping.remoteRoot)
            }
          }
        : {})
    })
  } else if (project.defaultRemoteConnectionId === connectionId) {
    delete project.defaultRemoteConnectionId
  }
  project.remoteConnections = remoteConnections
  projects[index] = project
  writeProjects(projects)
  return normalizeProjectAvailability(project)
}

export function updateProjectRemoteDefaults(
  id: string,
  defaults: {
    defaultRemoteConnectionId?: string | null
    remoteWorkspaceRoot?: string | null
  }
): Project {
  const projects = readProjects()
  const index = projects.findIndex((project) => project.id === id)
  if (index < 0) {
    throw new Error('项目不存在')
  }

  const project = { ...projects[index] }
  if (defaults.defaultRemoteConnectionId !== undefined) {
    if (defaults.defaultRemoteConnectionId === null) delete project.defaultRemoteConnectionId
    else project.defaultRemoteConnectionId = defaults.defaultRemoteConnectionId
  }
  if (defaults.remoteWorkspaceRoot !== undefined) {
    if (defaults.remoteWorkspaceRoot === null) delete project.remoteWorkspaceRoot
    else project.remoteWorkspaceRoot = defaults.remoteWorkspaceRoot
  }
  projects[index] = project
  writeProjects(projects)
  return normalizeProjectAvailability(project)
}

// Removes the project shortcut only — its working directory and any session
// history under it (discoverable by cwd regardless of this registry) are untouched.
export function deleteProject(id: string): void {
  writeProjects(readProjects().filter((project) => project.id !== id))
  remoteConnectionByProjectId.delete(id)
}
