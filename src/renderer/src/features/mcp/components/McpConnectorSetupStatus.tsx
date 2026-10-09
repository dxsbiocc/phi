import { Alert, CircularProgress, Stack, Typography } from '@mui/material'
import type { McpConnectorSetupProgress } from '../../../../../shared/mcpConnectorCatalog'
import { connectorSetupActive, connectorSetupLabel } from '../lib/connectorSetupPresentation'

export function McpConnectorSetupStatus({
  setup
}: {
  setup?: McpConnectorSetupProgress
}): React.JSX.Element | null {
  if (!setup || setup.phase === 'installed' || setup.phase === 'removed') return null
  const working = connectorSetupActive(setup)
  return (
    <Alert
      severity={setup.phase === 'failed' ? 'error' : setup.phase === 'ready' ? 'success' : 'info'}
      icon={working ? <CircularProgress size={18} /> : undefined}
      role={setup.phase === 'failed' ? 'alert' : 'status'}
      sx={{ mb: 3 }}
    >
      <Stack spacing={0.5}>
        <Typography variant="body2">{connectorSetupLabel(setup.phase)}</Typography>
        {setup.error && <Typography variant="body2">{setup.error}</Typography>}
        {setup.phase === 'starting' && (
          <Typography variant="body2">首次启动可能需要下载所需文件，请保持网络连接。</Typography>
        )}
      </Stack>
    </Alert>
  )
}
