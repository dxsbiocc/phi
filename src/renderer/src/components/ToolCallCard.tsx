import {
  Cancel as CancelIcon,
  CheckCircle as CheckCircleIcon,
  ExpandMore as ExpandMoreIcon,
  Terminal as TerminalIcon
} from '@mui/icons-material'
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Chip,
  CircularProgress,
  Typography
} from '@mui/material'
import type { ReactNode } from 'react'
import type { ToolCallItem } from '../types'

const MAX_OUTPUT_CHARS = 20000

function DiffAwareOutput({ text }: { text: string }): ReactNode {
  const clipped =
    text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…（输出已截断）` : text
  const lines = clipped.split('\n')
  const looksLikeDiff = lines.some((line) => /^[+-]{1}[^+-]/.test(line) || /^@@ /.test(line))

  if (!looksLikeDiff) {
    return (
      <Typography
        component="pre"
        variant="body2"
        sx={{ m: 0, fontFamily: 'var(--font-mono)', fontSize: '0.8rem', whiteSpace: 'pre-wrap' }}
      >
        {clipped}
      </Typography>
    )
  }

  return (
    <Box component="pre" sx={{ m: 0, fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>
      {lines.map((line, index) => {
        const color = line.startsWith('+')
          ? 'success.main'
          : line.startsWith('-')
            ? 'error.main'
            : line.startsWith('@@')
              ? 'info.main'
              : 'text.secondary'
        return (
          <Typography
            key={index}
            component="div"
            variant="body2"
            sx={{ fontFamily: 'inherit', fontSize: 'inherit', whiteSpace: 'pre-wrap', color }}
          >
            {line || ' '}
          </Typography>
        )
      })}
    </Box>
  )
}

function StatusIndicator({ status }: { status: ToolCallItem['status'] }): ReactNode {
  if (status === 'running') {
    return <CircularProgress size={16} aria-label="执行中" />
  }
  if (status === 'error') {
    return <CancelIcon color="error" fontSize="small" aria-label="失败" />
  }
  return <CheckCircleIcon color="success" fontSize="small" aria-label="完成" />
}

function ToolCallCard({ item }: { item: ToolCallItem }): React.JSX.Element {
  return (
    <Accordion
      disableGutters
      elevation={0}
      sx={{
        alignSelf: 'stretch',
        maxWidth: '92%',
        bgcolor: 'background.paper',
        border: 1,
        borderColor: item.status === 'error' ? 'error.dark' : 'grey.800',
        borderRadius: 2,
        '&:before': { display: 'none' }
      }}
    >
      <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ minHeight: 44 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0, width: '100%' }}>
          <TerminalIcon fontSize="small" sx={{ color: 'text.secondary', flexShrink: 0 }} />
          <Chip label={item.toolName} size="small" sx={{ fontFamily: 'var(--font-mono)' }} />
          <Typography
            variant="body2"
            noWrap
            sx={{ color: 'text.secondary', fontFamily: 'var(--font-mono)', flex: 1, minWidth: 0 }}
          >
            {item.argsPreview}
          </Typography>
          <Box sx={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
            <StatusIndicator status={item.status} />
          </Box>
        </Box>
      </AccordionSummary>
      <AccordionDetails sx={{ pt: 0 }}>
        {item.argsJson ? (
          <Box sx={{ mb: item.output ? 1.5 : 0 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              参数
            </Typography>
            <Typography
              component="pre"
              variant="body2"
              sx={{
                m: 0,
                fontFamily: 'var(--font-mono)',
                fontSize: '0.8rem',
                whiteSpace: 'pre-wrap',
                color: 'text.secondary'
              }}
            >
              {item.argsJson}
            </Typography>
          </Box>
        ) : null}
        {item.output ? (
          <Box>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              输出
            </Typography>
            <DiffAwareOutput text={item.output} />
          </Box>
        ) : null}
      </AccordionDetails>
    </Accordion>
  )
}

export default ToolCallCard
