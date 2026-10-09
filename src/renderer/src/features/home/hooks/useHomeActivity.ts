import { useEffect, useState } from 'react'

import { getRendererApi } from '../../../lib/rendererApi'
import type { HomeActivitySummary } from '../../../types'

interface HomeActivityState {
  data: HomeActivitySummary | null
  error: string | null
  loading: boolean
}

const initialState: HomeActivityState = {
  data: null,
  error: null,
  loading: true
}

export function useHomeActivity(refreshKey: string): HomeActivityState {
  const [state, setState] = useState<HomeActivityState>(initialState)

  useEffect(() => {
    let active = true

    void getRendererApi()
      .getHomeActivity()
      .then((data) => {
        if (active) setState({ data, error: null, loading: false })
      })
      .catch((error: unknown) => {
        if (!active) return
        setState({
          data: null,
          error: error instanceof Error ? error.message : '暂时无法读取活动记录',
          loading: false
        })
      })

    return () => {
      active = false
    }
  }, [refreshKey])

  return state
}
