import { useRef, useState } from 'react'
import { Box, Typography } from '@mui/material'

import { PackageUpdateDialog } from '../../components/PackageUpdateDialog'
import { SidePanelCard } from '../../components/SidePanelCard'
import { useUiLanguage } from '../../lib/i18n'
import { workspacePanelText } from '../../layout'
import type { PackageUpdateView } from '../../../../shared/packageManagerTypes'
import { MessageIcon } from './components/MessageIcon'
import { useMessages } from './hooks/useMessages'
import { messagesCopy } from './lib/messagesCopy'
import { buildMessages, orderMessagesByReadState, type Message } from './lib/messages'

/** Busy state is per package, not per dialog: reopening the same message stays disabled. */
function packageUpdateKey(update: PackageUpdateView): string {
  return `${update.type}:${update.id}`
}

export function MessagesPanel(): React.JSX.Element {
  useUiLanguage()
  const { packageUpdates, appUpdate, loaded, readIds, markRead, refreshPackageUpdates } =
    useMessages()
  const [selectedUpdate, setSelectedUpdate] = useState<PackageUpdateView | null>(null)
  const [updatingKeys, setUpdatingKeys] = useState<ReadonlySet<string>>(() => new Set())
  const updatingKeysRef = useRef(new Set<string>())

  const messages = orderMessagesByReadState(
    buildMessages({ updates: packageUpdates, appUpdate }),
    readIds
  )
  const selectedUpdateBusy =
    selectedUpdate !== null && updatingKeys.has(packageUpdateKey(selectedUpdate))

  const refresh = async (): Promise<void> => {
    await refreshPackageUpdates()
  }

  function apply(update: PackageUpdateView): void {
    const key = packageUpdateKey(update)
    if (updatingKeysRef.current.has(key)) return
    // Closing first lets the main process finish the update as a background job.
    setSelectedUpdate(null)
    updatingKeysRef.current.add(key)
    setUpdatingKeys(new Set(updatingKeysRef.current))
    void (async () => {
      try {
        await window.api.applyPackageUpdate(update.type, update.id)
        await refresh()
        // The update is gone from the refreshed list, so its message disappears too.
      } catch {
        // The background jobs list reports update failures; keep the message for a retry.
      } finally {
        updatingKeysRef.current.delete(key)
        setUpdatingKeys(new Set(updatingKeysRef.current))
      }
    })()
  }

  function openMessage(message: Message): void {
    markRead(message.id)
    if (message.kind === 'package-update' && message.packageUpdate) {
      setSelectedUpdate(message.packageUpdate)
      return
    }
    if (!message.releasesUrl) return
    try {
      void window.api.openAppReleasesPage(message.releasesUrl).catch(() => undefined)
    } catch {
      // Opening the release page is best-effort and never blocks the panel.
    }
  }

  const renderMessage = (message: Message): React.JSX.Element => {
    const read = readIds.has(message.id)
    return (
      <SidePanelCard
        key={message.id}
        role="button"
        tabIndex={0}
        aria-label={messagesCopy.openMessage(message.title)}
        data-phi-message={message.id}
        data-phi-message-read={read}
        onClick={() => openMessage(message)}
        onKeyDown={(event) => {
          if (event.currentTarget !== event.target) return
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            openMessage(message)
          }
        }}
        icon={<MessageIcon kind={message.kind} packageType={message.packageType} />}
        title={message.title}
        unread={!read}
        unreadLabel={messagesCopy.unreadMessage}
        status={message.status}
        statusPlacement="center"
        subtitle={message.subtitle}
      />
    )
  }

  return (
    <Box
      role="region"
      aria-label={messagesCopy.messages}
      data-phi-messages-panel="true"
      sx={{
        flex: 1,
        width: '100%',
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'background.paper'
      }}
    >
      <Box
        sx={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          overflowX: 'hidden',
          overflowY: 'auto',
          scrollbarGutter: 'stable both-edges'
        }}
      >
        {!loaded && (
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ ...workspacePanelText.body, py: 1 }}
          >
            {messagesCopy.loadingMessages}
          </Typography>
        )}
        {loaded && messages.length === 0 && (
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ ...workspacePanelText.body, py: 1 }}
          >
            {messagesCopy.noMessages}
          </Typography>
        )}
        {/* One list, unread first; opening the panel alone never marks anything read. */}
        <Box sx={{ pt: 0.75, px: 0.5 }}>{messages.map(renderMessage)}</Box>
      </Box>
      <PackageUpdateDialog
        open={selectedUpdate !== null}
        update={selectedUpdate}
        busy={selectedUpdateBusy}
        onClose={() => setSelectedUpdate(null)}
        onApply={apply}
      />
    </Box>
  )
}
