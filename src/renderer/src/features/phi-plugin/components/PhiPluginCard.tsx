import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Paper,
  Stack,
  Switch,
  Tooltip,
  Typography
} from '@mui/material'
import { alpha } from '@mui/material/styles'

import type { ManagedEnvironmentState } from '../../../../../shared/environmentTypes'
import { PhiIcons } from '../../../icons'
import type { PhiPluginDisplayItem } from '../hooks/usePhiPlugins'
import {
  phiPluginComponentName,
  phiPluginComponentSummary,
  phiPluginEnabledLabel,
  phiPluginEnvironmentStateLabel,
  phiPluginSourceLabel
} from '../lib/phiPlugins'

const PluginIcon = PhiIcons.entity.plugin
const DeleteIcon = PhiIcons.action.delete

function environmentColor(
  state: ManagedEnvironmentState | undefined
): 'default' | 'primary' | 'success' | 'warning' | 'error' {
  if (state === 'building') return 'primary'
  if (state === 'ready') return 'success'
  if (state === 'failed') return 'error'
  if (state === 'drifted') return 'warning'
  return 'default'
}

function ComponentGroup({
  title,
  values,
  preserveNames = false
}: {
  title: string
  values: readonly string[]
  preserveNames?: boolean
}): React.JSX.Element | null {
  if (values.length === 0) return null
  return (
    <Box>
      <Typography variant="caption" color="text.secondary">
        {title}
      </Typography>
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
    </Box>
  )
}

export function PhiPluginCard({
  plugin,
  busy,
  disabled,
  onSetEnabled,
  onRequestUninstall
}: {
  plugin: PhiPluginDisplayItem
  busy: boolean
  disabled: boolean
  onSetEnabled: (enabled: boolean) => void
  onRequestUninstall: () => void
}): React.JSX.Element {
  const agents = plugin.agents ?? []
  const skills = plugin.skills ?? []
  const scriptTools = plugin.scriptTools ?? []

  return (
    <Paper
      component="article"
      variant="outlined"
      sx={{
        p: 2.25,
        borderRadius: 2,
        minWidth: 0,
        transition: 'border-color 120ms ease, box-shadow 120ms ease',
        '&:hover': {
          borderColor: (theme) => alpha(theme.palette.primary.main, 0.38),
          boxShadow: (theme) => `0 8px 24px ${alpha(theme.palette.common.black, 0.06)}`
        }
      }}
    >
      <Stack spacing={1.75} sx={{ height: '100%' }}>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'flex-start' }}>
          <Box
            sx={{
              width: 44,
              height: 44,
              flexShrink: 0,
              borderRadius: 1.5,
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
            <PluginIcon />
          </Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="h6" sx={{ fontWeight: 750, lineHeight: 1.25 }}>
              {plugin.title}
            </Typography>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ fontFamily: 'var(--font-mono)', overflowWrap: 'anywhere' }}
            >
              {plugin.id} · v{plugin.version}
            </Typography>
          </Box>
          <Tooltip title={plugin.enabled ? '停用插件' : '启用插件'}>
            <span>
              <Switch
                size="small"
                checked={plugin.enabled}
                disabled={disabled}
                slotProps={{
                  input: { 'aria-label': `${plugin.enabled ? '停用' : '启用'} ${plugin.title}` }
                }}
                onChange={(event) => onSetEnabled(event.target.checked)}
              />
            </span>
          </Tooltip>
        </Stack>

        <Typography variant="body2" color="text.secondary" sx={{ minHeight: 40 }}>
          {plugin.summary}
        </Typography>

        <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }}>
          <Chip size="small" variant="outlined" label={phiPluginSourceLabel(plugin.source)} />
          <Chip
            size="small"
            color={plugin.enabled ? 'success' : 'default'}
            variant={plugin.enabled ? 'filled' : 'outlined'}
            label={phiPluginEnabledLabel(plugin.enabled)}
          />
          <Chip size="small" variant="outlined" label={phiPluginComponentSummary(plugin)} />
        </Stack>

        <Divider />

        <Stack spacing={1.25} sx={{ flex: 1 }}>
          <ComponentGroup title="智能体" values={agents} />
          <ComponentGroup title="技能" values={skills} />
          <ComponentGroup title="脚本工具（最终名称）" values={scriptTools} preserveNames />
          {plugin.environmentStatuses.length > 0 ? (
            <Box>
              <Typography variant="caption" color="text.secondary">
                环境
              </Typography>
              <Stack direction="row" spacing={0.75} useFlexGap sx={{ mt: 0.5, flexWrap: 'wrap' }}>
                {plugin.environmentStatuses.map((environment) => (
                  <Tooltip
                    key={`${environment.ref}:${environment.name}`}
                    title={environment.error ?? environment.ref}
                  >
                    <Chip
                      size="small"
                      color={environmentColor(environment.state)}
                      variant="outlined"
                      label={`${environment.name} · ${
                        environment.state
                          ? phiPluginEnvironmentStateLabel(environment.state)
                          : '状态未知'
                      }`}
                    />
                  </Tooltip>
                ))}
              </Stack>
            </Box>
          ) : null}
          {agents.length === 0 &&
          skills.length === 0 &&
          scriptTools.length === 0 &&
          plugin.environmentStatuses.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              此插件没有可显示的组件详情。
            </Typography>
          ) : null}
        </Stack>

        <Stack
          direction="row"
          spacing={1}
          sx={{ alignItems: 'center', justifyContent: 'space-between' }}
        >
          <Typography variant="caption" color="text.secondary">
            {new Date(plugin.installedAt).toLocaleDateString('zh-CN')} 安装
          </Typography>
          <Button
            size="small"
            color="error"
            disabled={disabled}
            startIcon={busy ? <CircularProgress size={14} color="inherit" /> : <DeleteIcon />}
            onClick={onRequestUninstall}
          >
            卸载
          </Button>
        </Stack>
      </Stack>
    </Paper>
  )
}
