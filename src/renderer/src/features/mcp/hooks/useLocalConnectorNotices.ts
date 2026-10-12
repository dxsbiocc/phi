import { useEffect, useRef } from 'react'

import {
  createLocalConnectorNoticeListener,
  type LocalConnectorNoticeListenerState,
  type LocalConnectorNoticeNotify
} from '../lib/localConnectorNoticeListener'

export function useLocalConnectorNotices(
  notify: LocalConnectorNoticeNotify,
  onOpenBackgroundJobs: (jobId?: string) => void,
  onReady: () => void | Promise<void>
): void {
  const stateRef = useRef<LocalConnectorNoticeListenerState>({
    notify,
    openJobs: onOpenBackgroundJobs,
    onReady,
    announcedKeys: new Set()
  })

  useEffect(() => {
    stateRef.current = { ...stateRef.current, notify, openJobs: onOpenBackgroundJobs, onReady }
  }, [notify, onOpenBackgroundJobs, onReady])

  useEffect(() => {
    const subscribe = window.api.onMcpConnectorSetupChanged
    if (typeof subscribe !== 'function') return undefined
    return subscribe(createLocalConnectorNoticeListener(stateRef))
  }, [])
}
