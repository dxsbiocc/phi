import { useEffect, useRef, useState } from 'react'
import type { McpConnectorSetupProgress } from '../../../../../shared/mcpConnectorCatalog'
import { cacheFeaturedToolNames, clearFeaturedToolNames } from '../lib/featuredToolCache'

export function useConnectorSetupProgress(
  open: boolean,
  onChange: (progress: McpConnectorSetupProgress) => void
): Record<string, McpConnectorSetupProgress> {
  const [byId, setById] = useState<Record<string, McpConnectorSetupProgress>>({})
  const revisions = useRef<Record<string, number>>({})
  useEffect(() => {
    if (!open || typeof window.api.onMcpConnectorSetupChanged !== 'function') return
    return window.api.onMcpConnectorSetupChanged((progress) => {
      if ((revisions.current[progress.id] ?? -1) >= progress.revision) return
      revisions.current[progress.id] = progress.revision
      setById((current) =>
        (current[progress.id]?.revision ?? -1) > progress.revision
          ? current
          : { ...current, [progress.id]: progress }
      )
      if (progress.phase === 'ready' && progress.toolNames) {
        cacheFeaturedToolNames(progress.id, progress.toolNames)
      } else {
        clearFeaturedToolNames(progress.id)
      }
      onChange(progress)
    })
  }, [open, onChange])
  return byId
}
