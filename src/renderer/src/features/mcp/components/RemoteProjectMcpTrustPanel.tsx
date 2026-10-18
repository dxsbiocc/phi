import { useUiLanguage } from '../../../lib/i18n'
import { resourceUi } from '../../../lib/resourceUi'
import { connectorCopy } from '../lib/connectorCopy'
import {
  Alert,
  Box,
  Button,
  Checkbox,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Stack,
  Typography
} from '@mui/material'
import { useMemo, useState } from 'react'
import { ConfirmationDialog } from '../../../components/ConfirmationDialog'

import type {
  RemoteProjectMcpConfirmationItem,
  RemoteProjectMcpTrustRequest
} from '../../../../../shared/remoteProjectMcpTypes'
import { RemoteProjectTrustStatus } from '../../agent/AgentTrustPanel'
import type { McpServerSummary } from '../lib/mcpTypes'
import {
  isRemoteProjectMcpServer,
  remoteProjectMcpTrustRequest,
  type TrustedRemoteProjectMcpServer
} from '../lib/remoteProjectMcpTrust'

function itemLabel(item: RemoteProjectMcpConfirmationItem): string {
  if (item.kind === 'stdio-command') return connectorCopy.command
  if (item.kind === 'stdio-arg') return connectorCopy.argumentNumber(item.index ?? 0)
  if (item.kind === 'stdio-env') return connectorCopy.environmentVariableName
  return connectorCopy.httpsUrl
}

export function RemoteProjectMcpTrustDialog({
  open,
  server,
  onClose,
  onTrusted
}: {
  open: boolean
  server: TrustedRemoteProjectMcpServer
  onClose: () => void
  onTrusted: (confirmedItemIds: string[]) => Promise<void>
}): React.JSX.Element {
  useUiLanguage()

  const [checked, setChecked] = useState<Set<string>>(() => new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const items = server.confirmationItems
  const allChecked = items.length > 0 && items.every((item) => checked.has(item.id))
  const groups = useMemo(() => {
    const grouped = new Map<string, RemoteProjectMcpConfirmationItem[]>()
    for (const item of items) {
      const entries = grouped.get(item.serverName) ?? []
      entries.push(item)
      grouped.set(item.serverName, entries)
    }
    return [...grouped.entries()]
  }, [items])

  const close = (): void => {
    setChecked(new Set())
    setError('')
    onClose()
  }
  const trust = async (): Promise<void> => {
    if (!allChecked) return
    setBusy(true)
    setError('')
    try {
      await onTrusted(items.map((item) => item.id))
      close()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <ConfirmationDialog open={open} onClose={busy ? undefined : close} disablePortal>
      <DialogTitle>{connectorCopy.trustServerConfig}</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          <Alert severity="warning">{connectorCopy.remoteCommandWarning}</Alert>
          <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
            {server.sourcePath}
          </Typography>
          {groups.map(([name, entries]) => (
            <Box key={name}>
              <Typography variant="subtitle2" sx={{ mb: 0.5, fontWeight: 700 }}>
                {name}
              </Typography>
              <Stack spacing={0.25}>
                {entries.map((item) => (
                  <FormControlLabel
                    key={item.id}
                    control={
                      <Checkbox
                        checked={checked.has(item.id)}
                        onChange={(_, next) => {
                          setChecked((current) => {
                            const updated = new Set(current)
                            if (next) updated.add(item.id)
                            else updated.delete(item.id)
                            return updated
                          })
                        }}
                      />
                    }
                    label={
                      <Box sx={{ minWidth: 0 }}>
                        <Typography variant="caption" color="text.secondary">
                          {itemLabel(item)}
                        </Typography>
                        <Typography
                          component="code"
                          sx={{
                            display: 'block',
                            whiteSpace: 'pre-wrap',
                            overflowWrap: 'anywhere',
                            fontFamily: 'var(--font-mono)'
                          }}
                        >
                          {item.value}
                        </Typography>
                      </Box>
                    }
                    sx={{ alignItems: 'flex-start', m: 0 }}
                  />
                ))}
              </Stack>
            </Box>
          ))}
          {error ? <Alert severity="error">{error}</Alert> : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button disabled={busy} onClick={close}>
          {resourceUi.cancel}
        </Button>
        <Button variant="contained" disabled={busy || !allChecked} onClick={() => void trust()}>
          {connectorCopy.confirmTrust}
        </Button>
      </DialogActions>
    </ConfirmationDialog>
  )
}

type RemoteMcpTrustApi = {
  trustRemoteProjectMcp(input: RemoteProjectMcpTrustRequest): Promise<unknown>
  revokeRemoteProjectMcpTrust(input: RemoteProjectMcpTrustRequest): Promise<unknown>
}

export function RemoteProjectMcpTrustPanel({
  server,
  onChanged
}: {
  server: McpServerSummary
  onChanged?: () => void | Promise<void>
}): React.JSX.Element | null {
  useUiLanguage()

  const [dialogOpen, setDialogOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!isRemoteProjectMcpServer(server)) return null
  const mutate = async (confirmedItemIds: string[], trusted: boolean): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const api = window.api as typeof window.api & RemoteMcpTrustApi
      const request = remoteProjectMcpTrustRequest(server, confirmedItemIds)
      if (trusted) await api.trustRemoteProjectMcp(request)
      else await api.revokeRemoteProjectMcpTrust(request)
      await onChanged?.()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      throw cause
    } finally {
      setBusy(false)
    }
  }
  return (
    <Stack spacing={1.25} sx={{ mt: 2 }}>
      <RemoteProjectTrustStatus resource={server} sourceLabel={connectorCopy.serverProjectMcp} />
      {server.trustState !== 'invalid' ? (
        <Box>
          <Button
            size="small"
            variant="outlined"
            disabled={busy}
            onClick={() => {
              if (server.trustState === 'trusted') void mutate([], false).catch(() => undefined)
              else setDialogOpen(true)
            }}
          >
            {server.trustState === 'trusted'
              ? connectorCopy.revokeTrust
              : server.trustState === 'changed'
                ? connectorCopy.trustAgain
                : connectorCopy.trust}
          </Button>
        </Box>
      ) : null}
      {error ? <Alert severity="error">{error}</Alert> : null}
      <RemoteProjectMcpTrustDialog
        key={server.contentHash}
        open={dialogOpen}
        server={server}
        onClose={() => setDialogOpen(false)}
        onTrusted={(confirmed) => mutate(confirmed, true)}
      />
    </Stack>
  )
}
