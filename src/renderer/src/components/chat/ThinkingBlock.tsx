import { Box, Collapse, Tooltip, Typography } from '@mui/material'
import { useState, type ReactNode } from 'react'
import { PhiIcons } from '../../icons'

const ChevronRightIcon = PhiIcons.action.back
const PsychologyIcon = PhiIcons.state.thinking

function formatThinkingDuration(durationMs?: number): string {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) return '思考'
  if (durationMs < 1000) return '思考了 1 s'

  const totalSeconds = Math.max(1, Math.round(durationMs / 1000))
  if (totalSeconds < 60) return `思考了 ${totalSeconds} s`

  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return seconds > 0 ? `思考了 ${minutes} m ${seconds} s` : `思考了 ${minutes} m`
}

export function ThinkingBlock({
  content,
  durationMs
}: {
  content: string
  durationMs?: number
}): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const toggle = (): void => setExpanded((value) => !value)
  const label = formatThinkingDuration(durationMs)

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
        <ThinkingIcon />
        <Typography component="span" variant="body2" noWrap sx={{ flex: 1, minWidth: 0 }}>
          {label}
        </Typography>
      </Box>
      <Collapse in={expanded} unmountOnExit>
        <Box sx={{ ml: 2.5, pl: 1.5, py: 1, minWidth: 0, borderLeft: 2, borderColor: 'grey.800' }}>
          <Typography
            variant="body2"
            sx={{
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              fontStyle: 'italic',
              color: 'text.secondary'
            }}
          >
            {content}
          </Typography>
        </Box>
      </Collapse>
    </Box>
  )
}

function ThinkingIcon({ size = 16 }: { size?: number }): ReactNode {
  return (
    <Tooltip title="思考" enterDelay={500}>
      <Box
        component="span"
        role="img"
        aria-label="思考"
        sx={{
          width: size + 2,
          height: size + 2,
          flexShrink: 0,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'text.secondary'
        }}
      >
        <PsychologyIcon sx={{ fontSize: size }} />
      </Box>
    </Tooltip>
  )
}
