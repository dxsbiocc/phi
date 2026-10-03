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

import type { ManagedEnvironmentState } from '../../../../../shared/environmentTypes'
import { PACKAGE_TRUST_DESCRIPTIONS, PACKAGE_TRUST_LABELS } from '../../../lib/packageTrust'
import { PhiIcons } from '../../../icons'
import type { PhiPluginDisplayItem } from '../hooks/usePhiPlugins'
import {
  phiPluginComponentName,
  phiPluginDistributionLabel,
  phiPluginEnabledLabel,
  phiPluginEnvironmentStateLabel
} from '../lib/phiPlugins'

function environmentColor(
  state: ManagedEnvironmentState | undefined
): 'default' | 'primary' | 'success' | 'warning' | 'error' {
  if (state === 'building') return 'primary'
  if (state === 'ready') return 'success'
  if (state === 'failed') return 'error'
  if (state === 'drifted') return 'warning'
  return 'default'
}

function ComponentSection({
  title,
  values,
  preserveNames = false
}: {
  title: string
  values: readonly string[]
  preserveNames?: boolean
}): React.JSX.Element {
  return (
    <Box component="section">
      <Typography variant="overline" color="text.secondary" sx={{ fontWeight: 700 }}>
        {title}
      </Typography>
      {values.length > 0 ? (
        <Stack direction="row" spacing={0.75} useFlexGap sx={{ mt: 0.5, flexWrap: 'wrap' }}>
          {values.map((value) => (
            <Chip
              key={value}
              size="small"
              variant="outlined"
              label={preserveNames ? value : phiPluginComponentName(value)}
              sx={preserveNames ? { fontFamily: 'var(--font-mono)' } : undefined}
            />
          ))}
        </Stack>
      ) : (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
          未提供
        </Typography>
      )}
    </Box>
  )
}

export type PhiPluginDetailProps = {
  plugin: PhiPluginDisplayItem | null
  busyPluginId: string | null
  error: string | null
  notice: string | null
  onClearError: () => void
  onClearNotice: () => void
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
  onSetEnabled,
  onUninstall
}: PhiPluginDetailProps): React.JSX.Element {
  const [pendingUninstall, setPendingUninstall] = useState<PhiPluginDisplayItem | null>(null)
  const busy = plugin !== null && busyPluginId === plugin.id

  async function confirmUninstall(): Promise<void> {
    if (!pendingUninstall) return
    if (await onUninstall(pendingUninstall)) setPendingUninstall(null)
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
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: '1fr', md: 'repeat(3, minmax(0, 1fr))' },
                  gap: 2.5
                }}
              >
                <ComponentSection title="智能体" values={plugin.agents ?? []} />
                <ComponentSection title="技能" values={plugin.skills ?? []} />
                <ComponentSection
                  title="脚本工具（最终名称）"
                  values={plugin.scriptTools ?? []}
                  preserveNames
                />
              </Box>

              <Divider />
              <Box component="section">
                <Typography variant="h6" sx={{ fontWeight: 700, mb: 1.25 }}>
                  环境
                </Typography>
                {plugin.environmentStatuses.length > 0 ? (
                  <Stack spacing={1}>
                    {plugin.environmentStatuses.map((environment) => (
                      <Stack
                        key={`${environment.ref}:${environment.name}`}
                        direction="row"
                        spacing={1.5}
                        sx={{
                          alignItems: 'center',
                          p: 1.5,
                          border: 1,
                          borderColor: 'divider',
                          borderRadius: 1.5
                        }}
                      >
                        <Box sx={{ flex: 1, minWidth: 0 }}>
                          <Typography sx={{ fontWeight: 650 }}>{environment.name}</Typography>
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            sx={{ fontFamily: 'var(--font-mono)' }}
                          >
                            {environment.ref}
                          </Typography>
                          {environment.error ? (
                            <Typography
                              variant="caption"
                              color="error"
                              sx={{ display: 'block', mt: 0.5 }}
                            >
                              {environment.error}
                            </Typography>
                          ) : null}
                        </Box>
                        <Chip
                          size="small"
                          color={environmentColor(environment.state)}
                          variant="outlined"
                          label={
                            environment.state
                              ? phiPluginEnvironmentStateLabel(environment.state)
                              : '状态未知'
                          }
                        />
                      </Stack>
                    ))}
                  </Stack>
                ) : (
                  <Typography variant="body2" color="text.secondary">
                    此插件未声明托管环境。
                  </Typography>
                )}
              </Box>

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
    </Box>
  )
}
