import { useCallback, useEffect, useState } from 'react'

import type {
  PhiPluginCatalogDetail,
  PhiPluginCatalogDetailReason
} from '../../../../../shared/phiPluginDetailTypes'

export type PhiPluginCatalogDetailStatus =
  | { id: string; status: 'loading' }
  | { id: string; status: 'available'; detail: PhiPluginCatalogDetail }
  | { id: string; status: 'unavailable'; reason: PhiPluginCatalogDetailReason }

export type PhiPluginCatalogDetailState = PhiPluginCatalogDetailStatus & {
  retry: () => void
}

export function usePhiPluginCatalogDetail(id: string): PhiPluginCatalogDetailState {
  const [state, setState] = useState<PhiPluginCatalogDetailStatus>({ id, status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let active = true
    void window.api
      .getPhiPluginCatalogDetail(id)
      .then((result) => {
        if (!active) return
        setState(
          result.status === 'available'
            ? { id, status: 'available', detail: result.detail }
            : { id, status: 'unavailable', reason: result.reason }
        )
      })
      .catch(() => {
        // An IPC rejection carries no trustworthy catalog answer, so it behaves like a
        // failed request rather than like a 404 from the official website.
        if (active) setState({ id, status: 'unavailable', reason: 'failed' })
      })

    return () => {
      active = false
    }
  }, [id, attempt])

  const retry = useCallback(() => {
    setState({ id, status: 'loading' })
    setAttempt((current) => current + 1)
  }, [id])

  const current: PhiPluginCatalogDetailStatus = state.id === id ? state : { id, status: 'loading' }
  return { ...current, retry }
}
