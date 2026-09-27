import {
  Alert,
  Box,
  IconButton,
  Chip,
  FormControlLabel,
  Paper,
  Stack,
  Switch,
  Tooltip,
  Typography
} from '@mui/material'
import { PhiIcons } from '../../icons'
import type { DbConnectorSettingsItem } from '../../types'

const RefreshIcon = PhiIcons.action.refresh

export function DatabaseSettingsPanel({
  connectors,
  isLoading,
  updatingConnectorId,
  onRefresh,
  onSetEnabled
}: {
  connectors: DbConnectorSettingsItem[]
  isLoading: boolean
  updatingConnectorId: string | null
  onRefresh: () => Promise<void>
  onSetEnabled: (id: string, enabled: boolean) => Promise<void>
}): React.JSX.Element {
  return (
    <Stack spacing={2}>
      <Box
        sx={{
          display: 'flex',
          alignItems: { xs: 'flex-start', md: 'center' },
          justifyContent: 'space-between',
          gap: 2,
          flexDirection: { xs: 'column', md: 'row' }
        }}
      >
        <Box>
          <Typography variant="h5">数据库</Typography>
          <Typography variant="body2" color="text.secondary">
            控制 Database agent 是否允许查询各个生物数据库。
          </Typography>
        </Box>
        <Tooltip title="刷新数据库">
          <span>
            <IconButton
              aria-label="刷新数据库"
              disabled={isLoading}
              onClick={() => void onRefresh()}
              sx={{ width: 40, height: 40, color: 'text.secondary' }}
            >
              <RefreshIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Box>

      <Alert severity="info" variant="outlined">
        Database agent 始终可以发现已安装的数据库。关闭某个数据库后仍可查看说明，但不会执行查询。
      </Alert>

      {isLoading && connectors.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          正在加载数据库...
        </Typography>
      ) : connectors.length === 0 ? (
        <Alert severity="warning" variant="outlined">
          没有找到已安装的数据库连接器。
        </Alert>
      ) : (
        <Stack spacing={1.25}>
          {connectors.map((connector) => {
            const updating = updatingConnectorId === connector.id
            return (
              <Paper key={connector.id} variant="outlined" sx={{ p: 2, borderRadius: 1 }}>
                <Box
                  sx={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 2,
                    alignItems: { xs: 'flex-start', md: 'center' },
                    flexDirection: { xs: 'column', md: 'row' }
                  }}
                >
                  <Stack spacing={0.75} sx={{ minWidth: 0 }}>
                    <Stack
                      direction="row"
                      spacing={1}
                      sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.75 }}
                    >
                      <Typography variant="body1" sx={{ fontWeight: 700 }}>
                        {connector.name}
                      </Typography>
                      <Chip size="small" variant="outlined" label={connector.id} />
                      <Chip
                        size="small"
                        color={connector.trustTier === 'bundled' ? 'success' : 'default'}
                        variant="outlined"
                        label={connector.trustTier === 'bundled' ? '内置' : '自定义'}
                      />
                    </Stack>
                    <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 0.75 }}>
                      <Chip size="small" label={connector.protocolFamily} />
                      <Chip
                        size="small"
                        variant="outlined"
                        label={`${connector.domainCount} domains`}
                      />
                      {connector.domains.slice(0, 4).map((domain) => (
                        <Chip key={domain.id} size="small" variant="outlined" label={domain.id} />
                      ))}
                    </Stack>
                  </Stack>

                  <FormControlLabel
                    disabled={updating}
                    control={
                      <Switch
                        checked={connector.enabledForQuery}
                        onChange={(event) => {
                          void onSetEnabled(connector.id, event.target.checked)
                        }}
                      />
                    }
                    label={connector.enabledForQuery ? '启用查询' : '关闭查询'}
                  />
                </Box>
              </Paper>
            )
          })}
        </Stack>
      )}
    </Stack>
  )
}
