import {
  Cancel as CancelIcon,
  CheckCircle as CheckCircleIcon,
  ChevronRight as ChevronRightIcon
} from '@mui/icons-material'
import { Box, Collapse, Typography } from '@mui/material'
import { useState, type ReactNode } from 'react'
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
        sx={{
          m: 0,
          fontFamily: 'var(--font-mono)',
          fontSize: '0.8rem',
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere'
        }}
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
            sx={{
              fontFamily: 'inherit',
              fontSize: 'inherit',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              color
            }}
          >
            {line || ' '}
          </Typography>
        )
      })}
    </Box>
  )
}

export function diffStat(output: string): { added: number; removed: number } | null {
  const lines = output.split('\n')
  let added = 0
  let removed = 0
  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) added += 1
    else if (line.startsWith('-') && !line.startsWith('---')) removed += 1
  }
  return added || removed ? { added, removed } : null
}

export function StatusIndicator({ status }: { status: ToolCallItem['status'] }): ReactNode {
  if (status === 'running') {
    return (
      <Box
        sx={{
          width: 14,
          height: 14,
          borderRadius: '50%',
          border: '2px solid',
          borderColor: 'grey.700',
          borderTopColor: 'text.secondary',
          animation: 'spin 800ms linear infinite',
          '@keyframes spin': { to: { transform: 'rotate(360deg)' } }
        }}
        aria-label="执行中"
      />
    )
  }
  if (status === 'error') {
    return <CancelIcon sx={{ fontSize: 14 }} color="error" aria-label="失败" />
  }
  return <CheckCircleIcon sx={{ fontSize: 14, color: 'success.main' }} aria-label="完成" />
}

function ToolCallCard({ item }: { item: ToolCallItem }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const stat = item.output ? diffStat(item.output) : null
  const toggle = (): void => setExpanded((value) => !value)

  return (
    <Box sx={{ alignSelf: 'stretch', minWidth: 0 }}>
      <Box
        role="button"
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            toggle()
          }
        }}
        aria-expanded={expanded}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          minWidth: 0,
          py: 0.5,
          px: 0.5,
          borderRadius: 1,
          cursor: 'pointer',
          color: 'text.secondary',
          transition: 'background-color 150ms',
          '&:hover': { bgcolor: 'action.hover' },
          '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' }
        }}
      >
        <ChevronRightIcon
          sx={{
            fontSize: 16,
            flexShrink: 0,
            transition: 'transform 150ms',
            transform: expanded ? 'rotate(90deg)' : 'none'
          }}
        />
        <Typography
          component="span"
          variant="body2"
          sx={{ fontFamily: 'var(--font-mono)', color: 'text.primary', flexShrink: 0 }}
        >
          {item.toolName}
        </Typography>
        <Typography
          component="span"
          variant="body2"
          noWrap
          sx={{ fontFamily: 'var(--font-mono)', flex: 1, minWidth: 0 }}
        >
          {item.argsPreview}
        </Typography>
        {stat ? (
          <Typography
            component="span"
            variant="caption"
            sx={{ flexShrink: 0, fontFamily: 'var(--font-mono)' }}
          >
            {stat.added ? (
              <Box component="span" sx={{ color: 'success.main' }}>
                +{stat.added}{' '}
              </Box>
            ) : null}
            {stat.removed ? (
              <Box component="span" sx={{ color: 'error.main' }}>
                -{stat.removed}
              </Box>
            ) : null}
          </Typography>
        ) : null}
        <Box sx={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
          <StatusIndicator status={item.status} />
        </Box>
      </Box>
      <Collapse in={expanded} unmountOnExit>
        <Box
          sx={{
            ml: 2.5,
            pl: 1.5,
            py: 1,
            minWidth: 0,
            borderLeft: 2,
            borderColor: 'grey.800'
          }}
        >
          {item.argsJson ? (
            <Box sx={{ mb: item.output ? 1.5 : 0, minWidth: 0 }}>
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
                  overflowWrap: 'anywhere',
                  color: 'text.secondary'
                }}
              >
                {item.argsJson}
              </Typography>
            </Box>
          ) : null}
          {item.output ? (
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                输出
              </Typography>
              <DiffAwareOutput text={item.output} />
            </Box>
          ) : null}
        </Box>
      </Collapse>
    </Box>
  )
}

export default ToolCallCard
