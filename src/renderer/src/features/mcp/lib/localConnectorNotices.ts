import type { McpConnectorSetupProgress } from '../../../../../shared/mcpConnectorCatalog'

export type LocalConnectorNotice = {
  message: string
  severity: 'info' | 'success' | 'error'
  action?: {
    label: string
    onClick: () => void
  }
}

export function localConnectorNoticeKey(progress: McpConnectorSetupProgress): string {
  return JSON.stringify([progress.id, progress.revision])
}

export function localConnectorNotice(
  progress: McpConnectorSetupProgress,
  announcedKeys: ReadonlySet<string>,
  onOpenBackgroundJobs: (jobId?: string) => void
): LocalConnectorNotice | null {
  if (progress.kind !== 'local-stdio') return null
  if (announcedKeys.has(localConnectorNoticeKey(progress))) return null

  const title = progress.title ?? progress.id
  const backgroundJobsAction = {
    label: '查看后台任务',
    onClick: () => onOpenBackgroundJobs()
  }

  if (progress.phase === 'starting') {
    return {
      message: `已开始添加 ${title}：正在后台启动并验证（首次运行可能需要几分钟）。`,
      severity: 'info',
      action: backgroundJobsAction
    }
  }
  if (progress.phase === 'ready') {
    return {
      message: `连接器 ${title} 已添加${
        progress.toolNames === undefined ? '' : `，发现 ${progress.toolNames.length} 个工具`
      }`,
      severity: 'success'
    }
  }
  if (progress.phase !== 'failed') return null
  if (progress.error === '已取消') {
    return { message: `已取消添加 ${title}`, severity: 'info' }
  }
  if (progress.failureKind === 'needs-setup') {
    return {
      message: `${title} 需要先完成配置，点击查看怎么做`,
      severity: 'info',
      action: { label: '去处理', onClick: () => onOpenBackgroundJobs(progress.id) }
    }
  }
  return {
    message: `添加 ${title} 失败：${progress.error ?? '未知错误'}${
      progress.detail ? '（详情见后台任务）' : ''
    }`,
    severity: 'error',
    action: backgroundJobsAction
  }
}
