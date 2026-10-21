import { useUiLanguage } from '../../../lib/i18n'
import { localizeRemoteSetupMessage, remoteSetupCopy } from '../lib/remoteSetupCopy'
import { useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  ListItemButton,
  Paper,
  Stack,
  Tooltip,
  Typography
} from '@mui/material'
import {
  GoAlert,
  GoAlertFill,
  GoArrowLeft,
  GoCheckCircle,
  GoChevronRight,
  GoPencil,
  GoPlug,
  GoPlus,
  GoServer,
  GoSync,
  GoTrash
} from 'react-icons/go'

import type { OpenSshHost, RemoteHostProfile } from '../../../types'
import type { SshHostAvailabilityStatus } from '../../../../../shared/sshHostAvailability'
import type { RemoteEnvironmentSettingInput } from '../../../../../shared/remoteEnvironmentTypes'
import {
  remoteDoctorTargetKey,
  remoteHostDoctorTarget,
  remoteHostCheckPresentation,
  type RemoteDoctorUiState
} from '../lib/remoteDoctorUi'
import { remoteHostRows, type RemoteHostRow } from '../lib/remoteHostRows'
import { RemoteHostDialog, type RemoteHostDraft } from './RemoteHostDialog'
import { RemoteHostEnvironmentEditor } from './RemoteHostEnvironmentEditor'

export type { RemoteHostDraft } from './RemoteHostDialog'

interface RemoteHostDetailProps {
  row: RemoteHostRow
  busy: boolean
  error: string | null
  doctorState: RemoteDoctorUiState
  onBack: () => void
  onEdit: (host: RemoteHostProfile) => void
  onDelete: (id: string) => void
  onTest: (host: RemoteHostProfile) => void
  onEnvironmentSave?: (host: RemoteHostProfile, input: RemoteEnvironmentSettingInput) => void
}

function hostSummary(row: RemoteHostRow): string {
  const user = row.saved.user ?? row.discovered?.user
  const address = row.discovered?.hostname ?? row.alias
  const port = row.saved.port ?? row.discovered?.port ?? 22
  return `${user ? `${user}@` : ''}${address}:${port}`
}

function savedConnectionStatus(status: SshHostAvailabilityStatus | undefined): {
  label: string
  color: 'default' | 'success' | 'warning' | 'error'
  icon: React.JSX.Element
} | null {
  if (status === 'available') {
    return { label: remoteSetupCopy.connected, color: 'success', icon: <GoCheckCircle /> }
  }
  if (status === 'attention') {
    return { label: remoteSetupCopy.attentionRequired, color: 'warning', icon: <GoAlert /> }
  }
  if (status === 'unavailable') {
    return { label: remoteSetupCopy.connectionFailed, color: 'error', icon: <GoAlertFill /> }
  }
  return null
}

function connectionStatus(
  check: ReturnType<typeof remoteHostCheckPresentation>,
  checking: boolean,
  saved?: SshHostAvailabilityStatus
): {
  label: string
  color: 'default' | 'success' | 'warning' | 'error'
  icon: React.JSX.Element
} {
  if (checking) return { label: remoteSetupCopy.checkingStatus, color: 'default', icon: <GoSync /> }
  if (check.tone === 'success') {
    return { label: remoteSetupCopy.connected, color: 'success', icon: <GoCheckCircle /> }
  }
  if (check.tone === 'warning') {
    return { label: remoteSetupCopy.attentionRequired, color: 'warning', icon: <GoAlert /> }
  }
  if (check.tone === 'error') {
    return { label: remoteSetupCopy.connectionFailed, color: 'error', icon: <GoAlertFill /> }
  }
  return (
    savedConnectionStatus(saved) ?? {
      label: remoteSetupCopy.notChecked,
      color: 'default',
      icon: <GoPlug />
    }
  )
}

function HostIdentity({ row }: { row: RemoteHostRow }): React.JSX.Element {
  useUiLanguage()
  const host = row.saved
  return (
    <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', minWidth: 0 }}>
      <Box
        sx={{
          width: 40,
          height: 40,
          borderRadius: 1.5,
          display: 'grid',
          placeItems: 'center',
          color: 'primary.main',
          flexShrink: 0
        }}
      >
        <GoServer size={20} aria-hidden="true" />
      </Box>
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 750 }} noWrap>
          {host.label}
        </Typography>
        <Typography
          variant="body2"
          color="text.secondary"
          noWrap
          title={hostSummary(row)}
          sx={{ mt: 0.25, fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}
        >
          {hostSummary(row)}
        </Typography>
      </Box>
    </Stack>
  )
}

function RemoteHostListRow({
  row,
  doctorState,
  savedStatus,
  onOpen
}: {
  row: RemoteHostRow
  doctorState: RemoteDoctorUiState
  savedStatus?: SshHostAvailabilityStatus
  onOpen: () => void
}): React.JSX.Element {
  useUiLanguage()
  const host = row.saved
  const key = remoteDoctorTargetKey(remoteHostDoctorTarget(host.id, host.hostAlias))
  const checking = doctorState.phase === 'running'
  const status = connectionStatus(
    remoteHostCheckPresentation(doctorState, key),
    checking,
    savedStatus
  )
  return (
    <Paper
      variant="outlined"
      sx={{ borderRadius: 1, width: '100%', minWidth: 0, overflow: 'hidden' }}
    >
      <ListItemButton
        aria-label={remoteSetupCopy.configureHost(host.label)}
        onClick={onOpen}
        sx={{ px: 1.5, py: 1.25, minHeight: 72, alignItems: 'center' }}
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <HostIdentity row={row} />
        </Box>
        <Stack direction="row" spacing={0.75} sx={{ ml: 2, alignItems: 'center', flexShrink: 0 }}>
          <Chip
            size="small"
            variant="outlined"
            label={host.source === 'ssh-config' ? 'OpenSSH' : remoteSetupCopy.legacyPhiProfile}
          />
          <Chip size="small" variant="soft" color={status.color} label={status.label} />
          <GoChevronRight size={18} color="var(--mui-palette-action-active)" aria-hidden="true" />
        </Stack>
      </ListItemButton>
    </Paper>
  )
}

function RemoteHostDetail({
  row,
  busy,
  error,
  doctorState,
  savedStatus,
  onBack,
  onEdit,
  onDelete,
  onTest,
  onEnvironmentSave
}: RemoteHostDetailProps & { savedStatus?: SshHostAvailabilityStatus }): React.JSX.Element {
  useUiLanguage()
  const host = row.saved
  const key = remoteDoctorTargetKey(remoteHostDoctorTarget(host.id, host.hostAlias))
  const check = remoteHostCheckPresentation(doctorState, key)
  const checking = doctorState.phase === 'running'
  const status = connectionStatus(check, checking, savedStatus)
  return (
    <Stack spacing={2.5}>
      <Box>
        <Button autoFocus startIcon={<GoArrowLeft />} onClick={onBack} sx={{ minHeight: 44 }}>
          {remoteSetupCopy.backToServers}
        </Button>
      </Box>

      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1.5}
        sx={{ alignItems: { sm: 'center' } }}
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <HostIdentity row={row} />
        </Box>
        <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', flexShrink: 0 }}>
          <Chip
            size="small"
            variant="outlined"
            label={host.source === 'ssh-config' ? 'OpenSSH' : remoteSetupCopy.legacyPhiProfile}
          />
          <Chip size="small" variant="soft" color={status.color} label={status.label} />
          <Tooltip
            title={
              check.tone === 'idle'
                ? remoteSetupCopy.testConnection
                : localizeRemoteSetupMessage(check.message)
            }
            arrow
          >
            <span>
              <IconButton
                aria-label={
                  check.tone === 'error'
                    ? remoteSetupCopy.retestFailedHost(host.label)
                    : checking
                      ? remoteSetupCopy.testingHost(host.label)
                      : remoteSetupCopy.testHost(host.label)
                }
                color={status.color}
                disabled={busy || checking}
                onClick={() => onTest(host)}
                sx={{ width: 44, height: 44 }}
              >
                {status.icon}
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title={remoteSetupCopy.editServer} arrow>
            <span>
              <IconButton
                aria-label={remoteSetupCopy.editItem(host.label)}
                disabled={busy || checking}
                onClick={() => onEdit(host)}
                sx={{ width: 44, height: 44 }}
              >
                <GoPencil size={19} aria-hidden="true" />
              </IconButton>
            </span>
          </Tooltip>
          {host.source !== 'ssh-config' && (
            <Tooltip title={remoteSetupCopy.deleteLegacyProfile} arrow>
              <span>
                <IconButton
                  aria-label={remoteSetupCopy.deleteItem(host.label)}
                  disabled={busy || checking}
                  onClick={() => {
                    onDelete(host.id)
                    onBack()
                  }}
                  sx={{ width: 44, height: 44, color: 'text.secondary' }}
                >
                  <GoTrash size={19} aria-hidden="true" />
                </IconButton>
              </span>
            </Tooltip>
          )}
        </Stack>
      </Stack>

      <Divider />

      {error && <Alert severity="error">{localizeRemoteSetupMessage(error)}</Alert>}
      {onEnvironmentSave && (
        <RemoteHostEnvironmentEditor
          key={`${host.id}:${host.runtimeRoot ?? ''}:${JSON.stringify(host.toolPaths ?? {})}`}
          host={host}
          busy={busy || checking}
          onSave={onEnvironmentSave}
        />
      )}
    </Stack>
  )
}

export function RemoteHostProfilesPanel({
  hosts,
  openSshHosts,
  configLoading,
  configError,
  dialogOpen,
  draft,
  busy,
  error,
  hostDoctorStates,
  savedAvailability = {},
  onDraftChange,
  onOpenAdd,
  onOpenEdit,
  onCloseDialog,
  onReloadConfig,
  onSave,
  onPasswordBootstrap,
  onDelete,
  onTest,
  onEnvironmentSave,
  initialSelectedHostAlias = null
}: {
  hosts: RemoteHostProfile[]
  openSshHosts: OpenSshHost[]
  configLoading: boolean
  configError: string | null
  dialogOpen: boolean
  draft: RemoteHostDraft
  busy: boolean
  error: string | null
  hostDoctorStates: Record<string, RemoteDoctorUiState>
  savedAvailability?: Record<string, SshHostAvailabilityStatus>
  onDraftChange: (draft: RemoteHostDraft) => void
  onOpenAdd: () => void
  onOpenEdit: (host: RemoteHostProfile) => void
  onCloseDialog: () => void
  onReloadConfig: () => void
  onSave: () => void
  onPasswordBootstrap?: () => void
  onDelete: (id: string) => void
  onTest: (host: RemoteHostProfile) => void
  onEnvironmentSave?: RemoteHostDetailProps['onEnvironmentSave']
  initialSelectedHostAlias?: string | null
}): React.JSX.Element {
  useUiLanguage()
  const rows = remoteHostRows(hosts, openSshHosts)
  const [selectedHostAlias, setSelectedHostAlias] = useState<string | null>(
    initialSelectedHostAlias
  )
  const selectedRow = rows.find((row) => row.alias === selectedHostAlias)

  return (
    <Box>
      {selectedRow ? (
        <RemoteHostDetail
          row={selectedRow}
          busy={busy}
          error={error}
          doctorState={hostDoctorStates[selectedRow.saved.id] ?? { phase: 'idle' }}
          savedStatus={savedAvailability[selectedRow.saved.id]}
          onBack={() => setSelectedHostAlias(null)}
          onEdit={onOpenEdit}
          onDelete={onDelete}
          onTest={onTest}
          onEnvironmentSave={onEnvironmentSave}
        />
      ) : (
        <Stack spacing={2}>
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1.5}
            sx={{ alignItems: { sm: 'center' } }}
          >
            <Box sx={{ flex: 1 }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <Typography variant="h6" sx={{ fontWeight: 750 }}>
                  {remoteSetupCopy.sshServer}
                </Typography>
                <Chip size="small" label={remoteSetupCopy.serverCount(rows.length)} />
              </Stack>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                {remoteSetupCopy.serverConfigurationHelp}
              </Typography>
            </Box>
            <Stack direction="row" spacing={0.5}>
              <Tooltip
                title={
                  configLoading ? remoteSetupCopy.refreshingServers : remoteSetupCopy.refreshServers
                }
                arrow
              >
                <span>
                  <IconButton
                    aria-label={remoteSetupCopy.refreshServers}
                    disabled={configLoading}
                    onClick={onReloadConfig}
                    sx={{ width: 44, height: 44 }}
                  >
                    {configLoading ? (
                      <CircularProgress size={18} />
                    ) : (
                      <GoSync size={19} aria-hidden="true" />
                    )}
                  </IconButton>
                </span>
              </Tooltip>
              <Button
                aria-label={remoteSetupCopy.addServer}
                variant="contained"
                size="small"
                startIcon={<GoPlus aria-hidden="true" />}
                disabled={busy}
                onClick={onOpenAdd}
                sx={{ minHeight: 44, px: 2 }}
              >
                {remoteSetupCopy.addServer}
              </Button>
            </Stack>
          </Stack>

          {configError && <Alert severity="warning">{configError}</Alert>}
          {error && !dialogOpen && (
            <Alert severity="error">{localizeRemoteSetupMessage(error)}</Alert>
          )}
          {configLoading && rows.length === 0 && (
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', py: 3 }}>
              <CircularProgress size={18} />
              <Typography variant="body2" color="text.secondary">
                {remoteSetupCopy.readingSshConfiguration}
              </Typography>
            </Stack>
          )}
          {!configLoading && rows.length === 0 && (
            <Box sx={{ py: 5, textAlign: 'center', borderTop: 1, borderColor: 'divider' }}>
              <GoServer size={28} color="var(--mui-palette-text-disabled)" aria-hidden="true" />
              <Typography variant="subtitle2" sx={{ mt: 1 }}>
                {remoteSetupCopy.noSshServers}
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                {remoteSetupCopy.addServerHelp}
              </Typography>
            </Box>
          )}
          {rows.length > 0 && (
            <Stack spacing={1.5} sx={{ minWidth: 0, width: '100%' }}>
              {rows.map((row) => (
                <RemoteHostListRow
                  key={row.alias}
                  row={row}
                  doctorState={hostDoctorStates[row.saved.id] ?? { phase: 'idle' }}
                  savedStatus={savedAvailability[row.saved.id]}
                  onOpen={() => setSelectedHostAlias(row.alias)}
                />
              ))}
            </Stack>
          )}
        </Stack>
      )}

      <RemoteHostDialog
        open={dialogOpen}
        draft={draft}
        busy={busy}
        error={dialogOpen ? error : null}
        onDraftChange={onDraftChange}
        onClose={onCloseDialog}
        onSave={onSave}
        onPasswordBootstrap={onPasswordBootstrap}
      />
    </Box>
  )
}
