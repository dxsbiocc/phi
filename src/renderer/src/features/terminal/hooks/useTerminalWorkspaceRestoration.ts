import { useEffect, useMemo } from 'react'

import type { Project } from '../../../lib/projectTypes'
import { isTerminalBridgeAvailable } from '../lib/terminalBridge'
import { getTerminalController } from '../lib/terminalController'
import { terminalWorkspaceRefFromActiveProject } from '../lib/terminalWorkspaceRef'

/** Reconnect existing terminals after a renderer reload without creating a shell. */
export function useTerminalWorkspaceRestoration(
  bridge: unknown,
  projects: readonly Project[],
  activeProjectId: string | null
): void {
  const activeProject = activeProjectId
    ? projects.find((project) => project.id === activeProjectId)
    : null
  const ready = !activeProjectId || Boolean(activeProject)
  const target = useMemo(
    () => terminalWorkspaceRefFromActiveProject(activeProject),
    [activeProject]
  )
  const controller = useMemo(
    () => (isTerminalBridgeAvailable(bridge) ? getTerminalController(bridge) : null),
    [bridge]
  )

  useEffect(() => {
    if (!controller || !ready || target === 'remote') return
    void controller.restoreWorkspace(target)
  }, [controller, ready, target])
}
