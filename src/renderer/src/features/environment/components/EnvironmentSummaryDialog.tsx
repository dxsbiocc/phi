import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'

import type { EnvironmentSnapshot } from '../../../types'

export type EnvironmentSummaryDialogProps = {
  open: boolean
  snapshot: EnvironmentSnapshot | null
  onClose: () => void
  onOpenSettings: () => void
}

export function EnvironmentSummaryDialog({
  open,
  snapshot,
  onClose,
  onOpenSettings
}: EnvironmentSummaryDialogProps): React.JSX.Element {
  const tools = snapshot?.tools ?? []
  const ready = tools.filter((tool) => tool.status === 'ready')
  const missing = tools.filter((tool) => tool.status !== 'ready')

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>工作台环境检测</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          已扫描本机常用工具并写入设置 →
          环境。未检测到的项不会阻止聊天；需要时再到设置中指定路径或安装。
        </Typography>

        <Alert severity="success" sx={{ mb: 1.5 }}>
          已检测到 {ready.length} 项
        </Alert>
        <Stack spacing={0.75} sx={{ mb: 2 }}>
          {ready.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              （无）
            </Typography>
          ) : (
            ready.map((tool) => (
              <Box key={tool.id} sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
                <Chip size="small" color="success" label="就绪" sx={{ mt: 0.25 }} />
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {tool.label}
                  </Typography>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}
                  >
                    {tool.activePath}
                    {tool.detectedVersion ? ` · ${tool.detectedVersion}` : ''}
                  </Typography>
                </Box>
              </Box>
            ))
          )}
        </Stack>

        <Alert severity={missing.length ? 'warning' : 'info'} sx={{ mb: 1.5 }}>
          未检测到 {missing.length} 项
        </Alert>
        <Stack spacing={0.75}>
          {missing.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              （无）
            </Typography>
          ) : (
            missing.map((tool) => (
              <Box key={tool.id} sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
                <Chip size="small" label="缺失" sx={{ mt: 0.25 }} />
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {tool.label}
                  </Typography>
                  {tool.messages?.[0] ? (
                    <Typography variant="caption" color="text.secondary">
                      {tool.messages[0]}
                    </Typography>
                  ) : null}
                </Box>
              </Box>
            ))
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onOpenSettings}>打开环境设置</Button>
        <Button variant="contained" onClick={onClose}>
          知道了
        </Button>
      </DialogActions>
    </Dialog>
  )
}
