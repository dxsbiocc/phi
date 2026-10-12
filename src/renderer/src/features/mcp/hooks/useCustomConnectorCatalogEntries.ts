import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { McpConnectorSetupProgress } from '../../../../../shared/mcpConnectorCatalog'
import type { McpServerSummary } from '../../../types'
import {
  customConnectorEntries,
  customConnectorReadySwitchKey,
  type CustomConnectorEntry
} from '../lib/customConnectorGroup'
import { useConnectorSetupProgress } from './useConnectorSetupProgress'

export function useCustomConnectorCatalogEntries({
  open,
  servers,
  page,
  onSetupChange,
  onReady
}: {
  open: boolean
  servers: readonly McpServerSummary[]
  page: 'list' | 'detail'
  onSetupChange: (progress: McpConnectorSetupProgress) => void
  onReady: () => void
}): {
  entries: CustomConnectorEntry[]
  setupById: Record<string, McpConnectorSetupProgress>
} {
  const readySwitchKeysRef = useRef(new Set<string>())
  useEffect(() => {
    if (!open) readySwitchKeysRef.current.clear()
  }, [open])
  const handleSetupChange = useCallback(
    (progress: McpConnectorSetupProgress) => {
      const switchKey = customConnectorReadySwitchKey(progress, page)
      if (switchKey && !readySwitchKeysRef.current.has(switchKey)) {
        readySwitchKeysRef.current.add(switchKey)
        onReady()
      }
      onSetupChange(progress)
    },
    [onReady, onSetupChange, page]
  )
  const setupById = useConnectorSetupProgress(open, handleSetupChange)
  const jobs = useMemo(() => Object.values(setupById), [setupById])
  const entries = useMemo(() => customConnectorEntries(servers, jobs), [jobs, servers])
  return { entries, setupById }
}
