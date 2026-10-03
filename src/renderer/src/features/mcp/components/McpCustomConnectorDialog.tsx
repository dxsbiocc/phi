import { useState } from 'react'
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField
} from '@mui/material'

export function McpCustomConnectorDialog({
  open,
  busy,
  error,
  onClose,
  onSubmit
}: {
  open: boolean
  busy: boolean
  error: string | null
  onClose: () => void
  onSubmit: (name: string, url: string) => void
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const canSubmit = Boolean(name.trim() && url.trim())

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle>添加自定义 MCP 连接器</DialogTitle>
      <DialogContent>
        <Alert severity="info" sx={{ mb: 2 }}>
          这里仅保存服务地址。需要登录的服务仍需单独完成授权，保存配置不代表连接成功。
        </Alert>
        <TextField
          autoFocus
          fullWidth
          label="名称"
          value={name}
          onChange={(event) => setName(event.target.value)}
          helperText="使用字母、数字、下划线或连字符"
          sx={{ mb: 2 }}
        />
        <TextField
          fullWidth
          label="HTTPS MCP 地址"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://example.com/mcp"
          onKeyDown={(event) => {
            if (event.key === 'Enter' && canSubmit && !busy) onSubmit(name, url)
          }}
        />
        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          取消
        </Button>
        <Button
          variant="contained"
          disabled={busy || !canSubmit}
          onClick={() => onSubmit(name, url)}
        >
          保存 MCP 配置
        </Button>
      </DialogActions>
    </Dialog>
  )
}
