import { useEffect, useState } from 'react'

import { errorMessage } from '../../../../../shared/errorCodes'
import type { VisualizationTemplateCatalog } from '../../../../../shared/visualizationTemplateTypes'

export function useVisualizationTemplates(enabled: boolean): {
  catalog: VisualizationTemplateCatalog | null
  loading: boolean
  error: string | null
} {
  const [state, setState] = useState<{
    catalog: VisualizationTemplateCatalog | null
    error: string | null
  }>({ catalog: null, error: null })

  useEffect(() => {
    if (!enabled || typeof window === 'undefined' || !window.api?.listVisualizationTemplates) return
    let cancelled = false
    window.api
      .listVisualizationTemplates()
      .then((catalog) => {
        if (!cancelled) setState({ catalog, error: null })
      })
      .catch((cause: unknown) => {
        if (!cancelled) setState({ catalog: null, error: errorMessage(cause) })
      })
    return () => {
      cancelled = true
    }
  }, [enabled])

  if (!enabled) return { catalog: null, loading: false, error: null }
  return {
    catalog: state.catalog,
    loading: state.catalog === null && state.error === null,
    error: state.error
  }
}
