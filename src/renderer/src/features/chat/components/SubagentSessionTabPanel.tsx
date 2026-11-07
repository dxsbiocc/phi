import { RemoteProjectFileContext } from '../../../lib/remoteProjectFileContext'
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { LocalPathKind } from '../../../components/MarkdownContent'
import type { WorkspaceSubagentTab } from '../../../lib/workspaceResourceTabs'
import { sessionAgentEventStates, subscribeSessionEvents } from '../../../stores/sessionStore'
import SubagentSessionView from '../SubagentSessionView'

/** Reads the same event cache as the parent chat, without activating or starting a session. */
export function SubagentSessionTabPanel({
  tab,
  onOpenLocalPath
}: {
  tab: WorkspaceSubagentTab
  onOpenLocalPath?: (path: string, kind: LocalPathKind) => void
}): React.JSX.Element {
  const subscribe = useCallback(
    (listener: () => void) => subscribeSessionEvents(tab.parentStateKey, listener),
    [tab.parentStateKey]
  )
  const snapshot = useCallback(() => {
    const item = sessionAgentEventStates
      .get(tab.parentStateKey)
      ?.messages.find((message) => message.id === tab.itemId && message.role === 'agent_execution')
    return item?.role === 'agent_execution' ? item : tab.initialItem
  }, [tab.parentStateKey, tab.itemId, tab.initialItem])
  const item = useSyncExternalStore(subscribe, snapshot, snapshot)
  const remoteFiles = useMemo(
    () =>
      tab.remoteFiles
        ? {
            ...tab.remoteFiles,
            openPath: (path: string, kind: LocalPathKind) => onOpenLocalPath?.(path, kind)
          }
        : null,
    [tab.remoteFiles, onOpenLocalPath]
  )
  return (
    <RemoteProjectFileContext.Provider value={remoteFiles}>
      <SubagentSessionView item={item} cwd={tab.cwd} onOpenLocalPath={onOpenLocalPath} />
    </RemoteProjectFileContext.Provider>
  )
}
