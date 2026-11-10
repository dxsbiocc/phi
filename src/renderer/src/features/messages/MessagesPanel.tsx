import { useState } from 'react'
import { Box, Typography } from '@mui/material'

import { PackageUpdateDialog } from '../../components/PackageUpdateDialog'
import { SidePanelCard } from '../../components/SidePanelCard'
import { useUiLanguage } from '../../lib/i18n'
import { workspacePanelText } from '../../layout'
import type { PackageUpdateView } from '../../../../shared/packageManagerTypes'
import { errorMessage } from '../../../../shared/errorCodes'
import { MessageIcon } from './components/MessageIcon'
import { useMessages } from './hooks/useMessages'
import { messagesCopy } from './lib/messagesCopy'
import { buildMessages, orderMessagesByReadState, type Message } from './lib/messages'

export function MessagesPanel(): React.JSX.Element {
  useUiLanguage()
  const { packageUpdates, appUpdate, loaded, readIds, markRead, refreshPackageUpdates } =
    useMessages()
  const [selectedUpdate, setSelectedUpdate] = useState<PackageUpdateView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const messages = orderMessagesByReadState(
    buildMessages({ updates: packageUpdates, appUpdate }),
    readIds
  )

  const refresh = async (): Promise<void> => {
    await refreshPackageUpdates()
  }

  async function apply(update: PackageUpdateView): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await window.api.applyPackageUpdate(update.type, update.id)
      await refresh()
      // The update is gone from the refreshed list, so its message disappears too.
      setSelectedUpdate(null)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  function openMessage(message: Message): void {
    markRead(message.id)
    if (message.kind === 'package-update' && message.packageUpdate) {
      setError(null)
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
      {error && (
        <Typography
          variant="caption"
          color="error.main"
          sx={{ ...workspacePanelText.body, px: 1.5, mb: 0.5 }}
        >
          {error}
        </Typography>
      )}
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
        busy={busy}
        error={error}
        onClose={() => {
          if (!busy) setSelectedUpdate(null)
        }}
        onApply={(update) => void apply(update)}
      />
    </Box>
  )
}
