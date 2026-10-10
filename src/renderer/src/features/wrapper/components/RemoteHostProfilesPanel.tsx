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
import { sshConfigHostId } from '../../../../../shared/remoteHostProfile'
import type { RemoteEnvironmentSettingInput } from '../../../../../shared/remoteEnvironmentTypes'
import {
  remoteDoctorTargetKey,
  remoteHostDoctorTarget,
  remoteHostCheckPresentation,
  type RemoteDoctorUiState
} from '../lib/remoteDoctorUi'
import { RemoteHostDialog, type RemoteHostDraft } from './RemoteHostDialog'
import { RemoteHostEnvironmentEditor } from './RemoteHostEnvironmentEditor'

export type { RemoteHostDraft } from './RemoteHostDialog'

interface HostRow {
  alias: string
  saved: RemoteHostProfile
  discovered?: OpenSshHost
}

interface RemoteHostDetailProps {
  row: HostRow
  busy: boolean
  error: string | null
  doctorState: RemoteDoctorUiState
  onBack: () => void
  onEdit: (host: RemoteHostProfile) => void
  onDelete: (id: string) => void
  onTest: (host: RemoteHostProfile) => void
  onEnvironmentSave?: (host: RemoteHostProfile, input: RemoteEnvironmentSettingInput) => void
}

function hostRows(hosts: RemoteHostProfile[], openSshHosts: OpenSshHost[]): HostRow[] {
  const savedByAlias = new Map(hosts.map((host) => [host.hostAlias, host]))
  const discoveredAliases = new Set(openSshHosts.map((host) => host.alias))
  return [
    ...openSshHosts.map((host) => ({
      alias: host.alias,
      saved: savedByAlias.get(host.alias) ?? {
        id: sshConfigHostId(host.alias),
        label: host.alias,
        hostAlias: host.alias,
        source: 'ssh-config'
      },
      discovered: host
    })),
    ...hosts
      .filter((host) => !discoveredAliases.has(host.hostAlias))
      .map((host) => ({ alias: host.hostAlias, saved: host }))
  ]
}

function hostSummary(row: HostRow): string {
  const user = row.saved.user ?? row.discovered?.user
  const address = row.discovered?.hostname ?? row.alias
  const port = row.saved.port ?? row.discovered?.port ?? 22
  return `${user ? `${user}@` : ''}${address}:${port}`
}

function connectionStatus(
  check: ReturnType<typeof remoteHostCheckPresentation>,
  checking: boolean
): {
  label: string
  color: 'default' | 'success' | 'warning' | 'error'
  icon: React.JSX.Element
} {
  if (checking) return { label: '检测中', color: 'default', icon: <GoSync /> }
  if (check.tone === 'success') {
    return { label: '连接正常', color: 'success', icon: <GoCheckCircle /> }
  }
  if (check.tone === 'warning') {
    return { label: '需要注意', color: 'warning', icon: <GoAlert /> }
  }
  if (check.tone === 'error') {
    return { label: '连接失败', color: 'error', icon: <GoAlertFill /> }
  }
  return { label: '未检测', color: 'default', icon: <GoPlug /> }
}

function HostIdentity({ row }: { row: HostRow }): React.JSX.Element {
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
          bgcolor: 'action.selected',
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
  onOpen
}: {
  row: HostRow
  doctorState: RemoteDoctorUiState
  onOpen: () => void
}): React.JSX.Element {
  const host = row.saved
  const key = remoteDoctorTargetKey(remoteHostDoctorTarget(host.id, host.hostAlias))
  const checking = doctorState.phase === 'running'
  const status = connectionStatus(remoteHostCheckPresentation(doctorState, key), checking)
  return (
    <ListItemButton
      aria-label={`配置 ${host.label}`}
      onClick={onOpen}
      sx={{
        px: 1,
        py: 1.25,
        minHeight: 72,
        borderBottom: 1,
        borderColor: 'divider',
        '&:last-child': { borderBottom: 0 }
      }}
    >
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <HostIdentity row={row} />
      </Box>
      <Stack direction="row" spacing={0.75} sx={{ ml: 2, alignItems: 'center', flexShrink: 0 }}>
        <Chip
          size="small"
          variant="outlined"
          label={host.source === 'ssh-config' ? 'OpenSSH' : '旧 Phi 档案'}
        />
        <Chip size="small" variant="soft" color={status.color} label={status.label} />
        <GoChevronRight size={18} color="var(--mui-palette-action-active)" aria-hidden="true" />
      </Stack>
    </ListItemButton>
  )
}

function RemoteHostDetail({
  row,
  busy,
  error,
  doctorState,
  onBack,
  onEdit,
  onDelete,
  onTest,
  onEnvironmentSave
}: RemoteHostDetailProps): React.JSX.Element {
  const host = row.saved
  const key = remoteDoctorTargetKey(remoteHostDoctorTarget(host.id, host.hostAlias))
  const check = remoteHostCheckPresentation(doctorState, key)
  const checking = doctorState.phase === 'running'
  const status = connectionStatus(check, checking)
  return (
    <Stack spacing={2.5}>
      <Box>
        <Button autoFocus startIcon={<GoArrowLeft />} onClick={onBack} sx={{ minHeight: 44 }}>
          返回服务器列表
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
            label={host.source === 'ssh-config' ? 'OpenSSH' : '旧 Phi 档案'}
          />
          <Chip size="small" variant="soft" color={status.color} label={status.label} />
          <Tooltip title={check.tone === 'idle' ? '测试连接' : check.message} arrow>
            <span>
              <IconButton
                aria-label={
                  check.tone === 'error'
                    ? `连接失败，重新测试 ${host.label}`
                    : checking
                      ? `正在测试 ${host.label}`
                      : `测试 ${host.label}`
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
          <Tooltip title="编辑服务器" arrow>
            <span>
              <IconButton
                aria-label={`编辑 ${host.label}`}
                disabled={busy || checking}
                onClick={() => onEdit(host)}
                sx={{ width: 44, height: 44 }}
              >
                <GoPencil size={19} aria-hidden="true" />
              </IconButton>
            </span>
          </Tooltip>
          {host.source !== 'ssh-config' && (
            <Tooltip title="删除旧 Phi 档案" arrow>
              <span>
                <IconButton
                  aria-label={`删除 ${host.label}`}
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

      {error && <Alert severity="error">{error}</Alert>}
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
  const rows = hostRows(hosts, openSshHosts)
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
                  SSH 服务器
                </Typography>
                <Chip size="small" label={`${rows.length} 台`} />
              </Stack>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                连接配置来自 ~/.ssh/config，选择服务器后管理运行环境。
              </Typography>
            </Box>
            <Stack direction="row" spacing={0.5}>
              <Tooltip title={configLoading ? '正在刷新服务器' : '刷新服务器'} arrow>
                <span>
                  <IconButton
                    aria-label="刷新服务器"
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
                aria-label="添加服务器"
                variant="contained"
                size="small"
                startIcon={<GoPlus aria-hidden="true" />}
                disabled={busy}
                onClick={onOpenAdd}
                sx={{ minHeight: 44, px: 2 }}
              >
                添加服务器
              </Button>
            </Stack>
          </Stack>

          {configError && <Alert severity="warning">{configError}</Alert>}
          {error && !dialogOpen && <Alert severity="error">{error}</Alert>}
          {configLoading && rows.length === 0 && (
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', py: 3 }}>
              <CircularProgress size={18} />
              <Typography variant="body2" color="text.secondary">
                正在读取 SSH 配置…
              </Typography>
            </Stack>
          )}
          {!configLoading && rows.length === 0 && (
            <Box sx={{ py: 5, textAlign: 'center', borderTop: 1, borderColor: 'divider' }}>
              <GoServer size={28} color="var(--mui-palette-text-disabled)" aria-hidden="true" />
              <Typography variant="subtitle2" sx={{ mt: 1 }}>
                还没有 SSH 服务器
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                添加服务器后，可以创建远程项目或从 Wrapper 选择远端计算。
              </Typography>
            </Box>
          )}
          {rows.length > 0 && (
            <Box sx={{ borderTop: 1, borderBottom: 1, borderColor: 'divider' }}>
              {rows.map((row) => (
                <RemoteHostListRow
                  key={row.alias}
                  row={row}
                  doctorState={hostDoctorStates[row.saved.id] ?? { phase: 'idle' }}
                  onOpen={() => setSelectedHostAlias(row.alias)}
                />
              ))}
            </Box>
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
