import { basename } from 'node:path'

import type { TerminalWorkspaceRef } from '../../shared/terminalTypes'
import type { Project } from '../agent/projects'
import { TerminalError } from './terminal-error'

export interface TerminalWorkspace {
  workspaceKey: string
  cwd: string
  label: string
}

export interface TerminalWorkspaceDependencies {
  getProject(projectId: string): Pick<Project, 'name' | 'location'> | undefined
  noProjectTaskFolder(): string
  realDirectory(path: string): string | null
  isRemoteAnchor(path: string): boolean
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

export function resolveTerminalWorkspace(
  ref: TerminalWorkspaceRef,
  deps: TerminalWorkspaceDependencies
): TerminalWorkspace {
  if (ref.kind === 'project') {
    const project = deps.getProject(ref.projectId)
    if (!project) throw new TerminalError('not_found', 'Project not found')
    if (project.location.kind === 'ssh') {
      throw new TerminalError('remote_unsupported', REMOTE_UNSUPPORTED_MESSAGE)
    }

    return {
      workspaceKey: `project:${ref.projectId}`,
      cwd: localDirectory(project.location.path, deps),
      label: project.name
    }
  }

  const cwd = localDirectory(deps.noProjectTaskFolder(), deps)
  return {
    workspaceKey: 'ordinary',
    cwd,
    label: basename(cwd) || 'workspace'
  }
}
