import { useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  Stack,
  Switch,
  Tooltip,
  Typography
} from '@mui/material'
import { alpha } from '@mui/material/styles'

import { EnvironmentBuildConfirmDialog } from '../../../components/EnvironmentBuildConfirmDialog'
import { PACKAGE_TRUST_DESCRIPTIONS, PACKAGE_TRUST_LABELS } from '../../../lib/packageTrust'
import { PhiIcons } from '../../../icons'
import type { PhiPluginDisplayItem, PhiPluginEnvironmentStatus } from '../hooks/usePhiPlugins'
import { requestPhiPluginEnvironmentBuild } from '../lib/environmentBuild'
import { phiPluginDistributionLabel, phiPluginEnabledLabel } from '../lib/phiPlugins'
import { PhiPluginComponentDetails } from './PhiPluginComponentDetails'
import { PhiPluginEnvironmentDetails } from './PhiPluginEnvironmentDetails'

export type PhiPluginDetailProps = {
  plugin: PhiPluginDisplayItem | null
  busyPluginId: string | null
  error: string | null
  notice: string | null
  onClearError: () => void
  onClearNotice: () => void
  onRefresh: () => Promise<void>
  onSetEnabled: (plugin: PhiPluginDisplayItem, enabled: boolean) => Promise<boolean>
  onUninstall: (plugin: PhiPluginDisplayItem) => Promise<boolean>
}

export function PhiPluginDetail({
  plugin,
  busyPluginId,
  error,
  notice,
  onClearError,
  onClearNotice,
  onRefresh,
  onSetEnabled,
  onUninstall
}: PhiPluginDetailProps): React.JSX.Element {
  const [pendingUninstall, setPendingUninstall] = useState<PhiPluginDisplayItem | null>(null)
  const [pendingBuildState, setPendingBuild] = useState<{
    pluginId: string
    environment: PhiPluginEnvironmentStatus
  } | null>(null)
  const [busyEnvironmentState, setBusyEnvironment] = useState<{
    pluginId: string
    envId: string
    kind: 'build' | 'rebuild'
  } | null>(null)
  const [environmentErrorState, setEnvironmentActionError] = useState<{
    pluginId: string
    message: string
  } | null>(null)
  const busy = plugin !== null && busyPluginId === plugin.id
  const pendingBuild =
    pendingBuildState && pendingBuildState.pluginId === plugin?.id
      ? pendingBuildState.environment
      : null
  const busyEnvironment =
    busyEnvironmentState && busyEnvironmentState.pluginId === plugin?.id
      ? busyEnvironmentState
      : null
  const environmentActionError =
    environmentErrorState && environmentErrorState.pluginId === plugin?.id
      ? environmentErrorState.message
      : null

  async function confirmUninstall(): Promise<void> {
    if (!pendingUninstall) return
    if (await onUninstall(pendingUninstall)) setPendingUninstall(null)
  }

  async function confirmBuild(): Promise<void> {
    if (!plugin || !pendingBuild) return
    setEnvironmentActionError(null)
    setBusyEnvironment({
      pluginId: plugin.id,
      envId: pendingBuild.envId ?? pendingBuild.ref,
      kind: 'build'
    })
    try {
      const result = await requestPhiPluginEnvironmentBuild(window.api, plugin.id, pendingBuild)
      setBusyEnvironment({ pluginId: plugin.id, envId: result.envId, kind: 'build' })
      setPendingBuild(null)
      await onRefresh()
    } catch (cause) {
      setEnvironmentActionError({
        pluginId: plugin.id,
        message: `无法构建环境：${cause instanceof Error ? cause.message : String(cause)}`
      })
      setBusyEnvironment(null)
      setPendingBuild(null)
    }
  }

  async function rebuildEnvironment(environment: PhiPluginEnvironmentStatus): Promise<void> {
    if (!environment.envId) return
    setEnvironmentActionError(null)
    if (!plugin) return
    setBusyEnvironment({
      pluginId: plugin.id,
      envId: environment.envId,
      kind: 'rebuild'
    })
    try {
      await window.api.rebuildManagedEnvironment(environment.envId)
      await onRefresh()
    } catch (cause) {
      setEnvironmentActionError({
        pluginId: plugin.id,
        message: `无法重新构建环境：${cause instanceof Error ? cause.message : String(cause)}`
      })
    } finally {
      setBusyEnvironment(null)
    }
  }

  return (
    <Box
      component="main"
      data-phi-plugin-detail="true"
      sx={{ flex: 1, minWidth: 0, minHeight: 0, height: '100%', overflowY: 'auto' }}
    >
      <Box sx={{ width: '100%', maxWidth: 940, mx: 'auto', px: { xs: 2.5, md: 4 }, py: 3.5 }}>
        <Stack spacing={2.5}>
          {error ? (
            <Alert severity="error" variant="outlined" onClose={onClearError}>
              {error}
            </Alert>
          ) : null}
          {notice ? (
            <Alert severity="success" variant="outlined" onClose={onClearNotice}>
              {notice}
            </Alert>
          ) : null}

          {plugin ? (
            <>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                <Box
                  sx={{
                    width: 58,
                    height: 58,
                    flexShrink: 0,
                    borderRadius: 2,
                    display: 'grid',
                    placeItems: 'center',
                    color: plugin.enabled ? 'primary.main' : 'text.disabled',
                    bgcolor: (theme) =>
                      alpha(
                        plugin.enabled ? theme.palette.primary.main : theme.palette.text.disabled,
                        theme.palette.mode === 'dark' ? 0.18 : 0.09
                      )
                  }}
                >
                  <PhiIcons.entity.plugin size={30} />
                </Box>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="h4" sx={{ fontWeight: 750 }}>
                    {plugin.title}
                  </Typography>
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{ mt: 0.25, fontFamily: 'var(--font-mono)', overflowWrap: 'anywhere' }}
                  >
                    {plugin.id} · v{plugin.version}
                  </Typography>
                  <Typography variant="body1" color="text.secondary" sx={{ mt: 1.25 }}>
                    {plugin.summary}
                  </Typography>
                  <Stack
                    direction="row"
                    spacing={0.75}
                    useFlexGap
                    sx={{ mt: 1.5, flexWrap: 'wrap' }}
                  >
                    <Chip
                      size="small"
                      variant="outlined"
                      label={phiPluginDistributionLabel(plugin.distribution)}
                    />
                    {/* A bundled plugin's trust tier is also 内置; show the tier only when it adds information. */}
                    {PACKAGE_TRUST_LABELS[plugin.trust] !==
                    phiPluginDistributionLabel(plugin.distribution) ? (
                      <Chip
                        size="small"
                        variant="outlined"
                        label={PACKAGE_TRUST_LABELS[plugin.trust]}
                        title={PACKAGE_TRUST_DESCRIPTIONS[plugin.trust]}
                      />
                    ) : null}
                    <Chip
                      size="small"
                      color={plugin.enabled ? 'success' : 'default'}
                      label={phiPluginEnabledLabel(plugin.enabled)}
                    />
                  </Stack>
                </Box>
                <Stack
                  direction="row"
                  spacing={1}
                  sx={{ alignItems: 'center', alignSelf: 'flex-start' }}
                >
                  <Typography variant="body2" color="text.secondary">
                    启用
                  </Typography>
                  <Tooltip title={plugin.enabled ? '停用插件' : '启用插件'}>
                    <span>
                      <Switch
                        checked={plugin.enabled}
                        disabled={busyPluginId !== null}
                        slotProps={{
                          input: {
                            'aria-label': `${plugin.enabled ? '停用' : '启用'} ${plugin.title}`
                          }
                        }}
                        onChange={(_event, checked) => void onSetEnabled(plugin, checked)}
                      />
                    </span>
                  </Tooltip>
                  <Button
                    color="error"
                    variant="outlined"
                    disabled={busyPluginId !== null}
                    startIcon={
                      busy ? (
                        <CircularProgress size={14} color="inherit" />
                      ) : (
                        <PhiIcons.action.delete size={16} />
                      )
                    }
                    onClick={() => setPendingUninstall(plugin)}
                  >
                    卸载
                  </Button>
                </Stack>
              </Stack>

              <Divider />
              <PhiPluginComponentDetails plugin={plugin} />

              <Divider />
              <PhiPluginEnvironmentDetails
                environments={plugin.environmentStatuses}
                busyEnvironment={busyEnvironment}
                busyPluginId={busyPluginId}
                actionError={environmentActionError}
                onDismissError={() => setEnvironmentActionError(null)}
                onBuild={(environment) => setPendingBuild({ pluginId: plugin.id, environment })}
                onRebuild={(environment) => void rebuildEnvironment(environment)}
              />

              <Divider />
              <Stack spacing={0.75}>
                <Typography variant="body2" color="text.secondary">
                  安装于 {new Date(plugin.installedAt).toLocaleString('zh-CN')}
                </Typography>
                <Typography
                  component="code"
                  variant="caption"
                  color="text.secondary"
                  sx={{ fontFamily: 'var(--font-mono)', overflowWrap: 'anywhere' }}
                >
                  {plugin.directory}
                </Typography>
              </Stack>
            </>
          ) : (
            <Stack spacing={1} sx={{ alignItems: 'center', textAlign: 'center', py: 12 }}>
              <PhiIcons.entity.plugin color="disabled" sx={{ fontSize: 42 }} />
              <Typography variant="h6">从左侧选择插件查看详情</Typography>
              <Typography variant="body2" color="text.secondary">
                旧版插件标签页会保留，但需要重新选择一个已安装插件。
              </Typography>
            </Stack>
          )}
        </Stack>
      </Box>

      <Dialog
        open={pendingUninstall !== null}
        onClose={busyPluginId ? undefined : () => setPendingUninstall(null)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>卸载 {pendingUninstall?.title ?? '插件'}？</DialogTitle>
        <DialogContent>
          <Stack spacing={1.25}>
            <DialogContentText>
              将移除此插件的智能体、技能、脚本工具和环境引用。仅由它使用且不再被引用的环境可以被清理。
            </DialogContentText>
            {pendingUninstall?.source === 'bundled' ? (
              <Alert severity="warning" variant="outlined">
                这是内置插件。卸载决定会被保留，Phi 下次启动时不会自动恢复它。
              </Alert>
            ) : null}
            <Typography component="code" variant="caption" sx={{ fontFamily: 'var(--font-mono)' }}>
              {pendingUninstall?.id} · v{pendingUninstall?.version}
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button disabled={Boolean(busyPluginId)} onClick={() => setPendingUninstall(null)}>
            取消
          </Button>
          <Button
            color="error"
            variant="contained"
            disabled={Boolean(busyPluginId)}
            onClick={() => void confirmUninstall()}
          >
            {busyPluginId ? '卸载中…' : '确认卸载'}
          </Button>
        </DialogActions>
      </Dialog>
      <EnvironmentBuildConfirmDialog
        environment={
          pendingBuild
            ? { ref: pendingBuild.ref, label: pendingBuild.name, estimate: pendingBuild.estimate }
            : null
        }
        working={Boolean(busyEnvironment)}
        onClose={() => setPendingBuild(null)}
        onConfirm={() => void confirmBuild()}
      />
    </Box>
  )
}
