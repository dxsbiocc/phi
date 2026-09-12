import { useCallback, useRef, useState } from 'react'
import type { McpServerSummary } from '../../../types'

export type McpServerCatalogState = {
  mcpServers: McpServerSummary[]
  activeMcpServerId: string | null
  setActiveMcpServerId: (id: string | null) => void
  refreshMcpServers: () => Promise<void>
}

export function useMcpServerCatalog(getActiveCwd: () => string): McpServerCatalogState {
  const [mcpServers, setMcpServers] = useState<McpServerSummary[]>([])
  const [activeMcpServerId, setActiveMcpServerId] = useState<string | null>(null)
  const mcpServersRequestRef = useRef(0)

  const refreshMcpServers = useCallback(async (): Promise<void> => {
    const request = ++mcpServersRequestRef.current
    const cwd = getActiveCwd()
    const list = await window.api.listMcpServers(cwd)
    if (request !== mcpServersRequestRef.current || cwd !== getActiveCwd()) return
    setMcpServers(list)
    setActiveMcpServerId((current) => current ?? list[0]?.id ?? null)
  }, [getActiveCwd])

  return {
    mcpServers,
    activeMcpServerId,
    setActiveMcpServerId,
    refreshMcpServers
  }
}
