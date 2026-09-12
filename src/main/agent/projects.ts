import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { basename, join } from 'node:path'
import { getPhiAgentDir } from './runtime-paths'

const PROJECTS_FILE = 'projects.json'

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

/**
 * A saved SSH target for remote wrapper execution — see
 * docs/design/phi-wrapper-technical-design.md's "Project state stores
 * references, not wrapper definitions". Deliberately holds no secret
 * material: `privateKeyPath` points at a key file already on disk (Phi
 * never copies or stores key bytes itself), and a passphrase — if the key
 * needs one — lives only in the OS keychain via `remote-credential-store.ts`
 * (Electron `safeStorage`), never in this JSON-on-disk `projects.json`
 * record. See `remote-connection-resolver.ts` for turning this plus the
 * stored passphrase into an actual `RemoteConnectionConfig`.
 */
export interface ProjectRemoteConnection {
  id: string
  label: string
  host: string
  port?: number
  username: string
  privateKeyPath: string
  /** True when the key at `privateKeyPath` needs a passphrase to unlock. */
  hasPassphrase?: boolean
}

export interface Project {
  id: string
  name: string
  workingDirectory: string
  workingDirectoryRealPath: string
  permissionMode: PermissionMode
  pathAvailable: boolean
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
  try {
    return {
      ...project,
      workingDirectoryRealPath: realpathSync(project.workingDirectory),
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

function readProjects(): Project[] {
  const projectsPath = getProjectsPath()
  if (!existsSync(projectsPath)) {
    return []
  }
  try {
    const raw = JSON.parse(readFileSync(projectsPath, 'utf-8'))
    return Array.isArray(raw) ? raw : []
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

export function listProjects(): Project[] {
  return readProjects()
    .map(normalizeProjectAvailability)
    .map((project) => ({
      ...project,
      gitStatus: project.pathAvailable ? readProjectGitStatus(project.workingDirectory) : undefined
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function getProject(id: string): Project | undefined {
  return readProjects().find((project) => project.id === id)
}

export function getProjectByCwd(cwd: string): Project | undefined {
  let realPath: string | undefined
  try {
    realPath = realpathSync(cwd)
  } catch {
    realPath = undefined
  }

  return readProjects().find(
    (project) =>
      project.workingDirectory === cwd ||
      (realPath !== undefined && project.workingDirectoryRealPath === realPath)
  )
}

export function assertProjectPathAvailable(workingDirectory: string): void {
  const project = readProjects().find((item) => item.workingDirectory === workingDirectory)
  if (project && !normalizeProjectAvailability(project).pathAvailable) {
    throw new Error('项目路径不可用，请移除或重新添加该项目')
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
  return project
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
  return project
}

export function createProject(input: {
  name: string
  workingDirectory: string
  permissionMode: PermissionMode
}): Project {
  const workingDirectoryRealPath = resolveProjectRealPath(input.workingDirectory)
  const projects = readProjects()
  if (projects.some((project) => project.workingDirectoryRealPath === workingDirectoryRealPath)) {
    throw new Error('项目已存在')
  }

  const project: Project = {
    id: randomUUID(),
    name: input.name.trim() || basename(input.workingDirectory) || '未命名项目',
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

/** Adds or replaces (by `connection.id`) one saved SSH target. Pass `null` to remove it — also clears `defaultRemoteConnectionId` if it pointed at the removed entry. Does not touch any stored passphrase; see `remote-credential-store.ts`, which the caller should clean up separately when actually removing a connection. */
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
    remoteConnections.push(patch)
  } else if (project.defaultRemoteConnectionId === connectionId) {
    delete project.defaultRemoteConnectionId
  }
  project.remoteConnections = remoteConnections
  projects[index] = project
  writeProjects(projects)
  return project
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
  return project
}

// Removes the project shortcut only — its working directory and any session
// history under it (discoverable by cwd regardless of this registry) are untouched.
export function deleteProject(id: string): void {
  writeProjects(readProjects().filter((project) => project.id !== id))
}
