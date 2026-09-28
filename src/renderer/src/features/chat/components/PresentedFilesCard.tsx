import { Box, Button, Paper, Typography } from '@mui/material'

import type { PresentedFilesItem } from '../../../types'
import { formatBytes } from '../../../lib/toolOutputPresentation'

export function PresentedFilesCard({
  item,
  onOpenFile
}: {
  item: PresentedFilesItem
  onOpenFile?: (path: string) => void
}): React.JSX.Element {
  return (
    <Paper
      variant="outlined"
      aria-label="交付文件"
      sx={{ mx: 1, my: 0.75, p: 1.5, borderRadius: 2, minWidth: 0 }}
    >
      <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
        交付文件 · {item.files.length} 个
      </Typography>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, mt: 1 }}>
        {item.files.map((file) => (
          <Box key={file.path} sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
            <Box sx={{ minWidth: 0, flex: 1 }}>
              {onOpenFile ? (
                <Button
                  size="small"
                  aria-label={`预览交付文件 ${file.displayPath}`}
                  onClick={() => onOpenFile(file.path)}
                  sx={{ minWidth: 0, maxWidth: '100%', p: 0, textTransform: 'none' }}
                >
                  <Typography noWrap variant="body2" sx={{ fontFamily: 'var(--font-mono)' }}>
                    {file.displayPath}
                  </Typography>
                </Button>
              ) : (
                <Typography noWrap variant="body2" sx={{ fontFamily: 'var(--font-mono)' }}>
                  {file.displayPath}
                </Typography>
              )}
              {file.description && (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                  {file.description}
                </Typography>
              )}
            </Box>
            <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
              {formatBytes(file.bytes)}
            </Typography>
          </Box>
        ))}
      </Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
        打开的是工作区中的当前文件，内容可能已更改。
      </Typography>
    </Paper>
  )
}
