import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Typography
} from '@mui/material'

import type { SessionSummary } from '../../../types'

export function SessionExportDialog({
  session,
  busy,
  onClose,
  onExport
}: {
  session: SessionSummary | null
  busy: boolean
  onClose: () => void
  onExport: () => void
}): React.JSX.Element {
  return (
    <Dialog open={session !== null} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>导出完整会话</DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ mb: 1.5 }}>
          将「{session?.name || session?.firstMessage || '未命名会话'}」导出到您选择的文件夹。 Phi
          会在其中创建独立的会话备份目录。
        </Typography>
        <Alert severity="warning">
          此备份包含完整对话、思考内容、工具输出、图片及运行时历史，可能含有密钥或其他敏感信息。请妥善保存。
        </Alert>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
          项目工作目录中的文件不会被复制。导出结果用于查看和备份，目前不能直接导入 Phi。
        </Typography>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button disabled={busy} onClick={onClose}>
          取消
        </Button>
        <Button disabled={busy} variant="contained" onClick={onExport}>
          {busy ? '正在导出…' : '选择位置并导出'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
