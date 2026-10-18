import { connectorCopy } from './connectorCopy'
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
    label: connectorCopy.viewBackgroundTasks,
    onClick: () => onOpenBackgroundJobs()
  }

  if (progress.phase === 'starting') {
    return {
      message: connectorCopy.addStarted(title),
      severity: 'info',
      action: backgroundJobsAction
    }
  }
  if (progress.phase === 'ready') {
    return {
      message: connectorCopy.addReady(title, progress.toolNames?.length),
      severity: 'success'
    }
  }
  if (progress.phase !== 'failed') return null
  if (progress.error === 'Cancelled' || progress.error === '已取消') {
    return { message: connectorCopy.addCancelled(title), severity: 'info' }
  }
  if (progress.failureKind === 'needs-setup') {
    return {
      message: connectorCopy.addNeedsSetup(title),
      severity: 'info',
      action: {
        label: connectorCopy.resolveSetup,
        onClick: () => onOpenBackgroundJobs(progress.id)
      }
    }
  }
  return {
    message: connectorCopy.addFailure(
      title,
      progress.error ?? connectorCopy.unknownError,
      Boolean(progress.detail)
    ),
    severity: 'error',
    action: backgroundJobsAction
  }
}
