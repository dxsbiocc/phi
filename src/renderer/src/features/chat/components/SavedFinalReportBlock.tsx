import { Box, Button, Typography } from '@mui/material'
import type { ReactNode } from 'react'
import { fileIconForPath } from '../../../icons'
import { useUiLanguage } from '../../../lib/i18n'
import type { AgentExecutionItem } from '../../../types'
import { chatCopy } from '../lib/chatCopy'

export function SavedFinalReportBlock({ item }: { item: AgentExecutionItem }): ReactNode {
  useUiLanguage()
  if (!item.finalReportTruncated || !item.finalReportPath) return null
  const icon = fileIconForPath(item.finalReportPath)
  const OutputFileIcon = icon.Icon
  return (
    <Box
      sx={{
        mb: 1.25,
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        minWidth: 0,
        flexWrap: 'wrap'
      }}
    >
      <OutputFileIcon sx={{ color: icon.color, fontSize: 22 }} />
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {chatCopy.fullReportSaved}
        </Typography>
        <Typography
          variant="caption"
          component="div"
          sx={{
            mt: 0.25,
            minWidth: 0,
            fontFamily: 'var(--font-mono)',
            color: 'text.secondary',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
          title={item.finalReportPath}
        >
          {item.finalReportPath}
        </Typography>
      </Box>
      <Button
        size="small"
        variant="outlined"
        onClick={() => {
          void window.api.revealPath(item.finalReportPath as string).catch((error) => {
            console.error('Failed to reveal agent report:', error)
          })
        }}
      >
        {chatCopy.revealInFolder}
      </Button>
    </Box>
  )
}
