import { useEffect, useState } from 'react'

import type { PhiPluginCatalogDetail } from '../../../../../shared/phiPluginDetailTypes'

export type PhiPluginCatalogDetailState =
  | { id: string; status: 'loading' }
  | { id: string; status: 'available'; detail: PhiPluginCatalogDetail }
  | { id: string; status: 'unavailable' }

export function usePhiPluginCatalogDetail(id: string): PhiPluginCatalogDetailState {
  const [state, setState] = useState<PhiPluginCatalogDetailState>({ id, status: 'loading' })

  useEffect(() => {
    let active = true
    void window.api
      .getPhiPluginCatalogDetail(id)
      .then((result) => {
        if (!active) return
        setState(
          result.status === 'available'
            ? { id, status: 'available', detail: result.detail }
            : { id, status: 'unavailable' }
        )
      })
      .catch(() => {
        if (active) setState({ id, status: 'unavailable' })
      })

    return () => {
      active = false
    }
  }, [id])

  return state.id === id ? state : { id, status: 'loading' }
}
