import {
  Box,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  Typography
} from '@mui/material'

import { PhiIcons } from '../../../icons'

const CloseIcon = PhiIcons.action.close
const MAX_RENDERED_LINES = 5000

export function WorkspaceDiffDialog({
  path,
  patch,
  error,
  onClose
}: {
  path: string | null
  patch: string | null
  error: string | null
  onClose: () => void
}): React.JSX.Element {
  const lines = patch?.split('\n') ?? []
  const visibleLines = lines.slice(0, MAX_RENDERED_LINES)

  return (
    <Dialog open={path !== null} onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography component="span" variant="h6" noWrap sx={{ flex: 1 }}>
          本轮差异 · {path}
        </Typography>
        <IconButton type="button" aria-label="关闭差异预览" onClick={onClose}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers sx={{ minHeight: 240, maxHeight: '75vh', p: 0 }}>
        {error ? (
          <Typography color="error" sx={{ p: 2 }}>
            {error}
          </Typography>
        ) : !patch ? (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, p: 2 }}>
            <CircularProgress size={18} />
            <Typography variant="body2">正在读取差异…</Typography>
          </Box>
        ) : (
          <Box
            component="pre"
            aria-label="逐文件差异"
            sx={{
              m: 0,
              p: 1.5,
              overflow: 'auto',
              fontFamily: 'var(--font-mono)',
              fontSize: '0.78rem',
              lineHeight: 1.5
            }}
          >
            {visibleLines.map((line, index) => (
              <Box
                key={index}
                component="div"
                sx={{
                  whiteSpace: 'pre',
                  minWidth: 'max-content',
                  color: line.startsWith('+')
                    ? 'success.main'
                    : line.startsWith('-')
                      ? 'error.main'
                      : line.startsWith('@@')
                        ? 'info.main'
                        : 'text.primary'
                }}
              >
                {line || ' '}
              </Box>
            ))}
            {lines.length > MAX_RENDERED_LINES && (
              <Typography variant="caption" color="text.secondary">
                仅显示前 {MAX_RENDERED_LINES} 行。
              </Typography>
            )}
          </Box>
        )}
      </DialogContent>
    </Dialog>
  )
}
