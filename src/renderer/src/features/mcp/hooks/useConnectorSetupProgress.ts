import { useEffect, useRef, useState } from 'react'
import type { McpConnectorSetupProgress } from '../../../../../shared/mcpConnectorCatalog'
import { cacheFeaturedToolNames, clearFeaturedToolNames } from '../lib/featuredToolCache'
import { mergeCustomConnectorJobs } from '../lib/customConnectorGroup'

export function useConnectorSetupProgress(
  open: boolean,
  onChange: (progress: McpConnectorSetupProgress) => void
): Record<string, McpConnectorSetupProgress> {
  const [byId, setById] = useState<Record<string, McpConnectorSetupProgress>>({})
  const revisions = useRef<Record<string, number>>({})
  useEffect(() => {
    if (!open) return undefined
    let active = true
    if (typeof window.api.listLocalConnectorJobs === 'function') {
      void window.api
        .listLocalConnectorJobs()
        .then((jobs) => {
          if (!active) return
          for (const job of jobs) {
            if (job.kind !== 'local-stdio') continue
            revisions.current[job.id] = Math.max(revisions.current[job.id] ?? -1, job.revision)
          }
          setById((current) =>
            Object.fromEntries(
              mergeCustomConnectorJobs(Object.values(current), jobs).map((job) => [job.id, job])
            )
          )
        })
        .catch(() => undefined)
    }
    const unsubscribe = window.api.onMcpConnectorSetupChanged?.((progress) => {
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
    return () => {
      active = false
      unsubscribe?.()
    }
  }, [open, onChange])
  return byId
}
