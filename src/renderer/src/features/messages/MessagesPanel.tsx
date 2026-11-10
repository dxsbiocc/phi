import { useEffect, useState } from 'react'
import { Box, Typography } from '@mui/material'

import { PackageUpdatesDialog } from '../../components/PackageUpdatesDialog'
import { SidePanelCard } from '../../components/SidePanelCard'
import { useUiLanguage } from '../../lib/i18n'
import { workspacePanelText } from '../../layout'
import type { PackageUpdateView } from '../../../../shared/packageManagerTypes'
import { errorMessage } from '../../../../shared/errorCodes'
import { MessageIcon } from './components/MessageIcon'
import { useMessages } from './hooks/useMessages'
import { messagesCopy } from './lib/messagesCopy'
import { buildMessages, type Message } from './lib/messages'

export function MessagesPanel(): React.JSX.Element {
  useUiLanguage()
  const { packageUpdates, appUpdate, loaded, markAllRead, refreshPackageUpdates } =
    useMessages()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const messages = buildMessages({ updates: packageUpdates, appUpdate })

  useEffect(() => {
    markAllRead()
  }, [markAllRead, packageUpdates, appUpdate])

  const refresh = async (): Promise<void> => {
    await refreshPackageUpdates()
  }

  async function apply(update: PackageUpdateView): Promise<void> {
    setBusyKey(`${update.type}:${update.id}`)
    setError(null)
    try {
      await window.api.applyPackageUpdate(update.type, update.id)
      await refresh()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusyKey(null)
    }
  }

  async function applyAll(): Promise<void> {
    setBusyKey('all')
    setError(null)
    try {
      await window.api.applyAllPackageUpdates()
      await refresh()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusyKey(null)
    }
  }

  function openMessage(message: Message): void {
    if (message.kind === 'package-updates') {
      setError(null)
      setDialogOpen(true)
      return
    }
    if (!message.releasesUrl) return
    try {
      void window.api.openAppReleasesPage(message.releasesUrl).catch(() => undefined)
    } catch {
      // Opening the release page is best-effort and never blocks the panel.
    }
  }

  const renderMessage = (message: Message): React.JSX.Element => (
    <SidePanelCard
      key={message.id}
      role="button"
      tabIndex={0}
      aria-label={messagesCopy.openMessage(message.title)}
      data-phi-message={message.id}
      onClick={() => openMessage(message)}
      onKeyDown={(event) => {
        if (event.currentTarget !== event.target) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          openMessage(message)
        }
      }}
      icon={<MessageIcon kind={message.kind} />}
      title={message.title}
      status={message.status}
      subtitle={message.subtitle}
    />
  )

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
        {/* Opening the panel marks everything read, so one plain list is enough. */}
        <Box sx={{ pt: 0.75, px: 0.5 }}>{messages.map(renderMessage)}</Box>
      </Box>
      <PackageUpdatesDialog
        open={dialogOpen}
        updates={packageUpdates}
        busyKey={busyKey}
        error={error}
        onClose={() => setDialogOpen(false)}
        onApply={(update) => void apply(update)}
        onApplyAll={() => void applyAll()}
      />
    </Box>
  )
}
