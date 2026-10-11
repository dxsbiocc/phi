import { basename } from 'node:path'

import type { TerminalWorkspaceRef } from '../../shared/terminalTypes'
import type { Project } from '../agent/projects'
import { TerminalError } from './terminal-error'
import { buildSshTerminalLaunch, type TerminalWorkspaceLaunch } from './terminal-launch'

export interface TerminalWorkspace {
  workspaceKey: string
  cwd: string
  label: string
  launch: TerminalWorkspaceLaunch
}

interface RemoteTerminalWorkspaceBinding {
  hostAlias: string
  remoteRoot: string
  connection: {
    host: string
    user?: string
    port?: number
    identityFile?: string
    userInitiated?: boolean
  }
}

export interface TerminalWorkspaceDependencies {
  getProject(projectId: string): Pick<Project, 'name' | 'location'> | undefined
  noProjectTaskFolder(): string
  realDirectory(path: string): string | null
  isRemoteAnchor(path: string): boolean
  resolveRemoteWorkspaceHostBinding?(
    input: { sessionId: string; projectId: string },
    options: { userInitiated: true }
  ): RemoteTerminalWorkspaceBinding
  sshExecutable?(): string
}

const DIRECTORY_MISSING_MESSAGE = 'Workspace directory is unavailable'
const REMOTE_UNSUPPORTED_MESSAGE = 'Remote workspaces are unsupported'

function localDirectory(path: string, deps: TerminalWorkspaceDependencies): string {
  if (deps.isRemoteAnchor(path)) {
    throw new TerminalError('remote_unsupported', REMOTE_UNSUPPORTED_MESSAGE)
  }

  const cwd = deps.realDirectory(path)
  if (!cwd) throw new TerminalError('directory_missing', DIRECTORY_MISSING_MESSAGE)
  if (deps.isRemoteAnchor(cwd)) {
    throw new TerminalError('remote_unsupported', REMOTE_UNSUPPORTED_MESSAGE)
  }
  return cwd
}

function resolveRemoteWorkspace(
  ref: Extract<TerminalWorkspaceRef, { kind: 'project' }>,
  project: Pick<Project, 'name' | 'location'>,
  deps: TerminalWorkspaceDependencies
): TerminalWorkspace {
  if (project.location.kind !== 'ssh') throw new Error('Expected an SSH project')
  if (!ref.sessionId) {
    throw new TerminalError('unavailable', '远程终端需要已绑定的项目会话')
  }
  if (!deps.resolveRemoteWorkspaceHostBinding) {
    throw new TerminalError('unavailable', '远程终端连接解析器不可用')
  }
  const localCwd = localDirectory(deps.noProjectTaskFolder(), deps)
  const binding = deps.resolveRemoteWorkspaceHostBinding(
    { sessionId: ref.sessionId, projectId: ref.projectId },
    { userInitiated: true }
  )
  // A new terminal is an explicit user action, so it bypasses the shared SSH auth cooldown.
  // Authentication errors occur inside the PTY and are intentionally not parsed or recorded.
  return {
    workspaceKey: `project:${ref.projectId}`,
    cwd: binding.remoteRoot,
    label: `${binding.hostAlias} · ${project.name}`,
    launch: buildSshTerminalLaunch({
      connection: binding.connection,
      remoteRoot: binding.remoteRoot,
      localCwd,
      hostLabel: binding.hostAlias,
      sshExecutable: deps.sshExecutable?.()
    })
  }
}

export function resolveTerminalWorkspace(
  ref: TerminalWorkspaceRef,
  deps: TerminalWorkspaceDependencies
): TerminalWorkspace {
  if (ref.kind === 'project') {
    const project = deps.getProject(ref.projectId)
    if (!project) throw new TerminalError('not_found', 'Project not found')
    if (project.location.kind === 'ssh') {
      return resolveRemoteWorkspace(ref, project, deps)
    }

    const cwd = localDirectory(project.location.path, deps)
    return {
      workspaceKey: `project:${ref.projectId}`,
      cwd,
      label: project.name,
      launch: { kind: 'local', localCwd: cwd }
    }
  }

  const cwd = localDirectory(deps.noProjectTaskFolder(), deps)
  return {
    workspaceKey: 'ordinary',
    cwd,
    label: basename(cwd) || 'workspace',
    launch: { kind: 'local', localCwd: cwd }
  }
}
