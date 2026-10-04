import { useEffect, useMemo } from 'react'

import type { TerminalRendererBridge } from '../../../../../shared/terminalTypes'
import type { Project } from '../../../lib/projectTypes'
import { getTerminalController } from '../lib/terminalController'
import { terminalWorkspaceRefFromActiveProject } from '../lib/terminalWorkspaceRef'

/** Reconnect existing terminals after a renderer reload without creating a shell. */
export function useTerminalWorkspaceRestoration(
  bridge: TerminalRendererBridge,
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
  const controller = useMemo(() => getTerminalController(bridge), [bridge])

  useEffect(() => {
    if (!ready || target === 'remote') return
    void controller.restoreWorkspace(target)
  }, [controller, ready, target])
}
