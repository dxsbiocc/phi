import type { Project } from '../../types'

function permissionLabel(project: Project): string {
  if (project.permissionMode === 'full') return '完全访问'
  if (project.permissionMode === 'auto') return '帮我批准'
  return '重要操作前询问'
}

function projectLocation(project: Project): string {
  return project.location.kind === 'ssh' ? project.location.remoteRoot : project.location.path
}

export function projectRowMetaLabel(project: Project): string | null {
  if (project.location.kind === 'ssh') return project.remoteHostAlias ?? '服务器不可用'
  if (!project.gitStatus) return null
  return project.gitStatus.dirty ? `${project.gitStatus.branch} · 有改动` : project.gitStatus.branch
}

export function projectHoverDetailRows(
  project: Project,
  sessionsReady: boolean,
  sessionCount: number
): Array<{ label: string; value: string }> {
  return [
    {
      label: project.location.kind === 'ssh' ? '服务器' : '类型',
      value: project.location.kind === 'ssh' ? (project.remoteHostAlias ?? '不可用') : '本地项目'
    },
    { label: '位置', value: projectLocation(project) },
    { label: '权限', value: permissionLabel(project) },
    ...(project.gitStatus
      ? [
          {
            label: 'Git',
            value: project.gitStatus.dirty
              ? `${project.gitStatus.branch} · 有改动`
              : project.gitStatus.branch
          }
        ]
      : []),
    { label: '对话', value: sessionsReady ? `${sessionCount} 个` : '正在读取' }
  ]
}
