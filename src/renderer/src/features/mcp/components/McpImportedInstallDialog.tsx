import {
  Alert,
  Button,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography
} from '@mui/material'

import { ConfirmationDialog } from '../../../components/ConfirmationDialog'
import type { FeaturedMcpConnector } from '../../../../../shared/mcpConnectorCatalog'

export function McpImportedInstallDialog({
  connector,
  open,
  busy = false,
  onCancel,
  onConfirm
}: {
  connector: FeaturedMcpConnector | null
  open: boolean
  busy?: boolean
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  return (
    <ConfirmationDialog open={open} onClose={busy ? undefined : onCancel} disablePortal>
      <DialogTitle>确认安装未签名连接器</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Alert severity="warning">
            这个连接器来自用户导入的软件源。安装后可能将在这台机器上运行其中的命令。
          </Alert>
          {connector?.source && (
            <Typography color="text.secondary">{connector.source.label} · 未签名</Typography>
          )}
          {connector?.transport === 'stdio' ? (
            <Stack spacing={1}>
              <Typography>
                command：<code>{connector.command ?? ''}</code>
              </Typography>
              <Typography sx={{ overflowWrap: 'anywhere' }}>
                args：<code>{JSON.stringify(connector.args ?? [])}</code>
              </Typography>
              <Typography sx={{ overflowWrap: 'anywhere' }}>
                environment：<code>{connector.environment ?? ''}</code>
              </Typography>
            </Stack>
          ) : (
            <Typography sx={{ overflowWrap: 'anywhere' }}>
              URL：<code>{connector?.url ?? ''}</code>
            </Typography>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button disabled={busy} onClick={onCancel}>
          取消
        </Button>
        <Button
          variant="contained"
          color="warning"
          disabled={busy || !connector}
          onClick={onConfirm}
        >
          确认并继续
        </Button>
      </DialogActions>
    </ConfirmationDialog>
  )
}
