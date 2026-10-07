import { useCallback, useRef, useState } from 'react'
import type { McpServerSummary } from '../../../types'
import { retainSelectedCatalogId } from '../../../lib/catalogSelection'

export type McpServerCatalogState = {
  mcpServers: McpServerSummary[]
  activeMcpServerId: string | null
  setActiveMcpServerId: (id: string | null) => void
  refreshMcpServers: () => Promise<void>
  refreshMcpServersForNavigation: () => Promise<void>
}

export function useMcpServerCatalog(getActiveCwd: () => string): McpServerCatalogState {
  const [mcpServers, setMcpServers] = useState<McpServerSummary[]>([])
  const [activeMcpServerId, setActiveMcpServerId] = useState<string | null>(null)
  const mcpServersRequestRef = useRef(0)
  const mcpServersReadRef = useRef<{
    cwd: string
    request: number
    promise: Promise<void>
  } | null>(null)

  const readMcpServers = useCallback(
    (force = false): Promise<void> => {
      const cwd = getActiveCwd()
      if (!force && mcpServersReadRef.current?.cwd === cwd) return mcpServersReadRef.current.promise
      const request = ++mcpServersRequestRef.current
      const promise = Promise.resolve()
        .then(() => window.api.listMcpServers(cwd))
        .then((list) => {
          if (request !== mcpServersRequestRef.current || cwd !== getActiveCwd()) return
          setMcpServers(list)
          setActiveMcpServerId((current) => retainSelectedCatalogId(current, list))
        })
        .finally(() => {
          if (mcpServersReadRef.current?.request === request) mcpServersReadRef.current = null
        })
      mcpServersReadRef.current = { cwd, request, promise }
      return promise
    },
    [getActiveCwd]
  )

  const refreshMcpServers = useCallback(() => readMcpServers(true), [readMcpServers])
  const refreshMcpServersForNavigation = useCallback(() => readMcpServers(), [readMcpServers])

  return {
    mcpServers,
    activeMcpServerId,
    setActiveMcpServerId,
    refreshMcpServers,
    refreshMcpServersForNavigation
  }
}
