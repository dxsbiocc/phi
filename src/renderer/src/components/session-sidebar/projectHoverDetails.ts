import { navigationCopy } from '../../lib/navigationCopy'
import type { Project } from '../../types'

function permissionLabel(project: Project): string {
  if (project.permissionMode === 'full') return navigationCopy.fullAccess
  if (project.permissionMode === 'auto') return navigationCopy.approveForMe
  return navigationCopy.askBeforeImportantActions
}

function projectLocation(project: Project): string {
  return project.location.kind === 'ssh' ? project.location.remoteRoot : project.location.path
}

export function projectRowMetaLabel(project: Project): string | null {
  if (project.location.kind === 'ssh')
    return project.remoteHostAlias ?? navigationCopy.serverUnavailable
  if (!project.gitStatus) return null
  return project.gitStatus.dirty
    ? navigationCopy.valueChanged(project.gitStatus.branch)
    : project.gitStatus.branch
}

export function projectHoverDetailRows(
  project: Project,
  sessionsReady: boolean,
  sessionCount: number
): Array<{ label: string; value: string }> {
  return [
    {
      label: project.location.kind === 'ssh' ? navigationCopy.server : navigationCopy.type,
      value:
        project.location.kind === 'ssh'
          ? (project.remoteHostAlias ?? navigationCopy.unavailable)
          : navigationCopy.localProject
    },
    { label: navigationCopy.location, value: projectLocation(project) },
    { label: navigationCopy.permissions, value: permissionLabel(project) },
    ...(project.gitStatus
      ? [
          {
            label: 'Git',
            value: project.gitStatus.dirty
              ? navigationCopy.valueChanged(project.gitStatus.branch)
              : project.gitStatus.branch
          }
        ]
      : []),
    {
      label: navigationCopy.conversation2,
      value: sessionsReady
        ? navigationCopy.valueConversations(sessionCount)
        : navigationCopy.loading
    }
  ]
}
