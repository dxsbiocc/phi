import { Alert, Box, IconButton, Paper, Stack, Tooltip, Typography } from '@mui/material'
import {
  GoAlert,
  GoAlertFill,
  GoCheckCircle,
  GoPencil,
  GoPlug,
  GoPlus,
  GoServer,
  GoSync,
  GoTrash
} from 'react-icons/go'

import type { OpenSshHost, RemoteHostProfile } from '../../../types'
import { sshConfigHostId } from '../../../../../shared/remoteHostProfile'
import {
  remoteDoctorTargetKey,
  remoteHostDoctorTarget,
  remoteHostCheckPresentation,
  type RemoteDoctorUiState
} from '../lib/remoteDoctorUi'
import { RemoteDoctorPanel } from './RemoteDoctorPanel'
import { RemoteHostDialog, type RemoteHostDraft } from './RemoteHostDialog'
import { RemoteHostRuntimeRootEditor } from './RemoteHostRuntimeRootEditor'

export type { RemoteHostDraft } from './RemoteHostDialog'

interface HostRow {
  alias: string
  saved: RemoteHostProfile
  discovered?: OpenSshHost
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
  onRuntimeRootSave,
  onRuntimeRootCheck
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
  onRuntimeRootSave?: (host: RemoteHostProfile, runtimeRoot?: string) => void
  onRuntimeRootCheck?: (host: RemoteHostProfile, runtimeRoot?: string) => void
}): React.JSX.Element {
  const rows = hostRows(hosts, openSshHosts)
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={1.5}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Typography variant="subtitle1" sx={{ flex: 1 }}>
            SSH 服务器
          </Typography>
          <Tooltip title={configLoading ? '正在刷新服务器' : '刷新服务器'} arrow>
            <span>
              <IconButton
                aria-label="刷新服务器"
                disabled={configLoading}
                onClick={onReloadConfig}
                sx={{ width: 44, height: 44 }}
              >
                <GoSync size={19} aria-hidden="true" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="添加服务器" arrow>
            <span>
              <IconButton
                aria-label="添加服务器"
                disabled={busy}
                onClick={onOpenAdd}
                sx={{ width: 44, height: 44 }}
              >
                <GoPlus size={20} aria-hidden="true" />
              </IconButton>
            </span>
          </Tooltip>
        </Stack>
        {configError && <Alert severity="warning">{configError}</Alert>}
        {error && !dialogOpen && <Alert severity="error">{error}</Alert>}
        {configLoading && rows.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            正在读取 SSH 配置…
          </Typography>
        )}
        {!configLoading && rows.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            暂无服务器；可以手动添加。
          </Typography>
        )}
        {rows.length > 0 && (
          <Box>
            {rows.map((row) => {
              const host = row.saved
              const key = remoteDoctorTargetKey(remoteHostDoctorTarget(host.id, host.hostAlias))
              const check = remoteHostCheckPresentation(hostDoctorStates[host.id], key)
              const checking = hostDoctorStates[host.id]?.phase === 'running'
              return (
                <Box
                  key={row.alias}
                  sx={{
                    py: 1.25,
                    borderBottom: '1px solid',
                    borderColor: 'divider',
                    '&:last-child': { borderBottom: 0 }
                  }}
                >
                  <Stack
                    direction={{ xs: 'column', sm: 'row' }}
                    spacing={1}
                    sx={{ alignItems: { sm: 'center' } }}
                  >
                    <GoServer
                      size={19}
                      color="var(--mui-palette-action-active)"
                      aria-hidden="true"
                    />
                    <Box sx={{ minWidth: 0, flex: 1 }}>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {host.label}
                      </Typography>
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        noWrap
                        sx={{ display: 'block' }}
                      >
                        {hostSummary(row)}
                      </Typography>
                    </Box>
                    <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                      <Tooltip
                        title={
                          <Box sx={{ whiteSpace: 'pre-line', maxWidth: 360 }}>{check.message}</Box>
                        }
                        arrow
                      >
                        <span>
                          <IconButton
                            aria-label={
                              check.tone === 'error'
                                ? `连接失败，重新测试 ${host.label}`
                                : checking
                                  ? `正在测试 ${host.label}`
                                  : `测试 ${host.label}`
                            }
                            color={
                              check.tone === 'error'
                                ? 'error'
                                : check.tone === 'warning'
                                  ? 'warning'
                                  : check.tone === 'success'
                                    ? 'success'
                                    : 'default'
                            }
                            disabled={busy || checking}
                            onClick={() => onTest(host)}
                            sx={{
                              width: 44,
                              height: 44,
                              ...(checking
                                ? {
                                    '@keyframes phiHostCheckSpin': {
                                      to: { transform: 'rotate(360deg)' }
                                    },
                                    '& svg': {
                                      animation: 'phiHostCheckSpin 1s linear infinite',
                                      '@media (prefers-reduced-motion: reduce)': {
                                        animation: 'none'
                                      }
                                    }
                                  }
                                : {})
                            }}
                          >
                            {check.tone === 'error' ? (
                              <GoAlertFill size={19} aria-hidden="true" />
                            ) : check.tone === 'warning' ? (
                              <GoAlert size={19} aria-hidden="true" />
                            ) : check.tone === 'success' ? (
                              <GoCheckCircle size={19} aria-hidden="true" />
                            ) : checking ? (
                              <GoSync size={19} aria-hidden="true" />
                            ) : (
                              <GoPlug size={19} aria-hidden="true" />
                            )}
                          </IconButton>
                        </span>
                      </Tooltip>
                      <Tooltip title="编辑服务器" arrow>
                        <span>
                          <IconButton
                            aria-label={`编辑 ${host.label}`}
                            disabled={busy || checking}
                            onClick={() => onOpenEdit(host)}
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
                              onClick={() => onDelete(host.id)}
                              sx={{ width: 44, height: 44 }}
                            >
                              <GoTrash size={19} aria-hidden="true" />
                            </IconButton>
                          </span>
                        </Tooltip>
                      )}
                    </Stack>
                  </Stack>
                  <RemoteDoctorPanel
                    state={hostDoctorStates[host.id] ?? { phase: 'idle' }}
                    targetKey={key}
                  />
                  {onRuntimeRootSave && onRuntimeRootCheck && (
                    <Box sx={{ mt: 1.5 }}>
                      <RemoteHostRuntimeRootEditor
                        key={`${host.id}:${host.runtimeRoot ?? ''}`}
                        host={host}
                        doctorState={hostDoctorStates[host.id] ?? { phase: 'idle' }}
                        busy={busy || checking}
                        onSave={onRuntimeRootSave}
                        onCheck={onRuntimeRootCheck}
                      />
                    </Box>
                  )}
                </Box>
              )
            })}
          </Box>
        )}
      </Stack>
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
    </Paper>
  )
}
