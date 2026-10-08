import { useId, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField
} from '@mui/material'
import type { RemoteMcpConnectorOptions } from '../../../../../shared/mcpConnectorCatalog'
import { PhiIcons } from '../../../icons'

export function McpCustomConnectorDialog({
  open,
  busy,
  authorizing = false,
  error,
  onClose,
  onSubmit
}: {
  open: boolean
  busy: boolean
  authorizing?: boolean
  error: string | null
  onClose: () => void
  onSubmit: (name: string, url: string, options?: RemoteMcpConnectorOptions) => void
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const authenticationId = useId()
  const missingClientId = Boolean(clientSecret.trim() && !clientId.trim())
  const canSubmit = Boolean(name.trim() && url.trim() && !missingClientId)

  function submit(): void {
    if (!canSubmit || busy) return
    const oauth = {
      ...(clientId.trim() ? { clientId: clientId.trim() } : {}),
      ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {})
    }
    onSubmit(name.trim(), url.trim(), Object.keys(oauth).length ? { oauth } : undefined)
  }

  return (
    <Dialog
      open={open}
      onClose={busy && !authorizing ? undefined : onClose}
      maxWidth="xs"
      fullWidth
    >
      <Box
        component="form"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <DialogTitle>添加自定义连接器</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            disabled={busy}
            fullWidth
            label="名称"
            value={name}
            onChange={(event) => setName(event.target.value)}
            helperText="使用字母、数字、下划线或连字符"
            sx={{ mt: 1, mb: 2 }}
          />
          <TextField
            fullWidth
            disabled={busy}
            label="服务器地址"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://example.com/mcp"
          />
          <Button
            type="button"
            disabled={busy}
            aria-expanded={advancedOpen}
            aria-controls={authenticationId}
            onClick={() => setAdvancedOpen((value) => !value)}
            startIcon={
              <Box sx={{ display: 'flex', transform: advancedOpen ? 'rotate(180deg)' : undefined }}>
                <PhiIcons.action.expand size={16} />
              </Box>
            }
            sx={{ mt: 2, mb: advancedOpen ? 1 : 0, color: 'text.primary' }}
          >
            高级设置
          </Button>
          <Collapse in={advancedOpen} id={authenticationId}>
            <TextField
              fullWidth
              disabled={busy}
              label="OAuth Client ID（可选）"
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
              autoComplete="off"
              error={missingClientId}
              helperText={missingClientId ? '使用 Client Secret 时需要填写 Client ID' : undefined}
              sx={{ mt: 1, mb: 2 }}
            />
            <TextField
              fullWidth
              disabled={busy}
              label="OAuth Client Secret（可选）"
              type="password"
              value={clientSecret}
              onChange={(event) => setClientSecret(event.target.value)}
              autoComplete="new-password"
            />
          </Collapse>
          {error && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {error}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button type="button" onClick={onClose} disabled={busy && !authorizing}>
            {authorizing ? '取消授权' : '取消'}
          </Button>
          <Button variant="contained" type="submit" disabled={busy || !canSubmit}>
            {authorizing ? '正在授权…' : busy ? '正在添加…' : '添加'}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  )
}
