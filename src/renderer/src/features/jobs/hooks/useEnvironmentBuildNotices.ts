import { useEffect, useRef } from 'react'

import type { EnvironmentBuild } from '../../../../../shared/environmentBuildTypes'
import { environmentBuildNotice } from '../lib/environmentBuildNotices'

export function useEnvironmentBuildNotices(
  notify: (message: string, severity: 'info' | 'success' | 'error') => void
): void {
  const notifyRef = useRef(notify)
  const statesRef = useRef(new Map<string, EnvironmentBuild['state']>())

  useEffect(() => {
    notifyRef.current = notify
  }, [notify])

  useEffect(() => {
    const subscribe = window.api.onEnvironmentBuildsChanged
    if (typeof subscribe !== 'function') return undefined
    return subscribe((build) => {
      const notice = environmentBuildNotice(statesRef.current.get(build.envId), build)
      statesRef.current.set(build.envId, build.state)
      if (notice) notifyRef.current(notice.message, notice.severity)
    })
  }, [])
}
