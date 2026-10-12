import type { McpConnectorSetupProgress } from '../../../../../shared/mcpConnectorCatalog'
import { localConnectorNotice, localConnectorNoticeKey } from './localConnectorNotices'

type NoticeAction = {
  label: string
  onClick: () => void
}

export type LocalConnectorNoticeNotify = (
  message: string,
  severity: 'info' | 'success' | 'error',
  options?: { action?: NoticeAction }
) => void

export type LocalConnectorNoticeListenerState = {
  notify: LocalConnectorNoticeNotify
  openJobs: (jobId?: string) => void
  onReady: () => void | Promise<void>
  announcedKeys: ReadonlySet<string>
}

export function createLocalConnectorNoticeListener(state: {
  current: LocalConnectorNoticeListenerState
}): (progress: McpConnectorSetupProgress) => void {
  return (progress) => {
    if (progress.kind === 'local-stdio' && progress.phase === 'ready') {
      void Promise.resolve().then(() => state.current.onReady())
    }
    const notice = localConnectorNotice(
      progress,
      state.current.announcedKeys,
      state.current.openJobs
    )
    if (!notice) return
    state.current = {
      ...state.current,
      announcedKeys: new Set([...state.current.announcedKeys, localConnectorNoticeKey(progress)])
    }
    state.current.notify(
      notice.message,
      notice.severity,
      notice.action ? { action: notice.action } : undefined
    )
  }
}
