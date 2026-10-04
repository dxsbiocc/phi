import { useCallback, useMemo, useSyncExternalStore } from 'react'

import type {
  TerminalRendererBridge,
  TerminalSnapshot,
  TerminalWorkspaceRef
} from '../../../../../shared/terminalTypes'
import type { Project } from '../../../lib/projectTypes'
import { useSessionStore } from '../../../stores/sessionStore'
import {
  getTerminalController,
  type TerminalController,
  type TerminalSize,
  type TerminalWorkspaceSnapshot
} from '../lib/terminalController'
import {
  terminalWorkspaceRefFromActiveProject,
  type TerminalWorkspaceTarget
} from '../lib/terminalWorkspaceRef'

const REMOTE_SNAPSHOT: TerminalWorkspaceSnapshot = {
  workspaceKey: 'remote',
  terminals: [],
  activeTerminalId: null,
  pending: false,
  error: null
}
const initializedWorkspaces = new WeakMap<TerminalController, Set<string>>()

function initializedWorkspaceKeys(controller: TerminalController): Set<string> {
  let keys = initializedWorkspaces.get(controller)
  if (!keys) {
    keys = new Set()
    initializedWorkspaces.set(controller, keys)
  }
  return keys
}

export interface TerminalWorkspaceHookValue {
  controller: TerminalController
  target: TerminalWorkspaceTarget
  projectName: string
  initialDirectory?: string
  ready: boolean
  initialized: boolean
  snapshot: TerminalWorkspaceSnapshot
  activeTerminal: TerminalSnapshot | null
  ensure(initialSize?: TerminalSize): Promise<TerminalWorkspaceSnapshot | null>
  create(initialSize?: TerminalSize): Promise<TerminalSnapshot | null>
  select(terminalId: string): void
  close(terminalId: string): Promise<boolean>
  closeAll(): Promise<void>
}

export function useTerminalWorkspace(
  bridge: TerminalRendererBridge,
  projects: readonly Project[]
): TerminalWorkspaceHookValue {
  const activeProjectId = useSessionStore((state) => state.activeProjectId)
  const activeProject = activeProjectId
    ? projects.find((project) => project.id === activeProjectId)
    : null
  const ready = !activeProjectId || Boolean(activeProject)
  const target = useMemo(
    () => terminalWorkspaceRefFromActiveProject(activeProject),
    [activeProject]
  )
  const controller = useMemo(() => getTerminalController(bridge), [bridge])
  const ref = target === 'remote' ? null : target

  const subscribe = useCallback(
    (listener: () => void) => (ref ? controller.subscribe(listener) : () => undefined),
    [controller, ref]
  )
  const getSnapshot = useCallback(
    () => (ref ? controller.getWorkspaceSnapshot(ref) : REMOTE_SNAPSHOT),
    [controller, ref]
  )
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const initialized =
    target === 'remote' ||
    snapshot.terminals.length > 0 ||
    initializedWorkspaceKeys(controller).has(snapshot.workspaceKey)
  const activeTerminal =
    snapshot.terminals.find((terminal) => terminal.terminalId === snapshot.activeTerminalId) ?? null

  const ensure = useCallback(
    (initialSize?: TerminalSize): Promise<TerminalWorkspaceSnapshot | null> => {
      if (!ready || !ref) return Promise.resolve(null)
      initializedWorkspaceKeys(controller).add(snapshot.workspaceKey)
      return controller.ensureWorkspace(ref, initialSize)
    },
    [controller, ready, ref, snapshot.workspaceKey]
  )
  const create = useCallback(
    (initialSize?: TerminalSize): Promise<TerminalSnapshot | null> => {
      if (!ready || !ref) return Promise.resolve(null)
      return controller.create(ref, initialSize)
    },
    [controller, ready, ref]
  )
  const select = useCallback(
    (terminalId: string): void => {
      if (ref) controller.select(ref, terminalId)
    },
    [controller, ref]
  )
  const close = useCallback(
    (terminalId: string): Promise<boolean> => controller.close(terminalId),
    [controller]
  )
  const closeAll = useCallback(
    (): Promise<void> => (ref ? controller.closeWorkspace(ref) : Promise.resolve()),
    [controller, ref]
  )

  return {
    controller,
    target,
    projectName: activeProject?.name ?? '普通工作区',
    initialDirectory:
      activeProject?.location.kind === 'ssh'
        ? activeProject.location.remoteRoot
        : activeProject?.workingDirectory,
    ready,
    initialized,
    snapshot,
    activeTerminal,
    ensure,
    create,
    select,
    close,
    closeAll
  }
}

export function isLocalTerminalWorkspace(
  target: TerminalWorkspaceTarget
): target is TerminalWorkspaceRef {
  return target !== 'remote'
}
