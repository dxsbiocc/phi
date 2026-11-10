import type { ReactNode } from 'react'
import { Box, Stack, Typography, type BoxProps, type SxProps, type Theme } from '@mui/material'

/**
 * The visual card shared by Background Jobs rows and the Messages panel.
 *
 * Interaction stays with each feature: callers pass the usual Box event and
 * accessibility props through. This component only owns the card surface, the
 * icon/text rhythm, and the two-line content layout.
 */
export function SidePanelCard({
  icon,
  title,
  status,
  statusColor = 'text.secondary',
  subtitle,
  statusPlacement = 'title',
  titleEmphasis = 'strong',
  compact = false,
  reserveActionSpace = false,
  footer,
  actions,
  sx,
  ...boxProps
}: Omit<BoxProps, 'children'> & {
  icon: ReactNode
  title: string
  status: string
  statusColor?: string
  subtitle: string
  /**
   * `title` keeps the status beside the first line. `center` puts it on the
   * right, vertically centered against the whole card.
   */
  statusPlacement?: 'title' | 'center'
  /** Messages dim read titles; jobs and other cards stay at full emphasis. */
  titleEmphasis?: 'strong' | 'muted'
  /** Workflow steps use the shorter single-line card. */
  compact?: boolean
  /** Leaves room for absolutely positioned actions on the right. */
  reserveActionSpace?: boolean
  /** Pinned to the bottom edge, such as a progress bar. */
  footer?: ReactNode
  /** Absolutely positioned controls, such as stop and retry. */
  actions?: ReactNode
}): React.JSX.Element {
  const centeredStatus = statusPlacement === 'center'
  const titleSx =
    titleEmphasis === 'muted' ? { fontWeight: 600, color: 'text.secondary' } : { fontWeight: 700 }
  const subtitleNode = compact ? null : (
    <Typography variant="caption" color="text.secondary" component="div" title={subtitle} noWrap>
      {subtitle}
    </Typography>
  )
  return (
    <Box {...boxProps} sx={[cardSx(compact), ...(Array.isArray(sx) ? sx : sx ? [sx] : [])]}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', minWidth: 0, width: '100%' }}>
        {icon}
        <Box sx={{ minWidth: 0, flex: 1, pr: reserveActionSpace ? 3.5 : 0 }}>
          {centeredStatus ? (
            <>
              <Typography
                variant="body2"
                noWrap
                sx={[{ minWidth: 0, fontSize: '0.92rem' }, titleSx]}
                title={title}
              >
                {title}
              </Typography>
              {subtitleNode}
            </>
          ) : (
            <>
              <Stack direction="row" spacing={0.75} sx={{ alignItems: 'baseline', minWidth: 0 }}>
                <Typography
                  variant="body2"
                  noWrap
                  sx={[{ minWidth: 0, flex: 1, fontSize: '0.92rem' }, titleSx]}
                  title={title}
                >
                  {title}
                </Typography>
                <Typography variant="caption" noWrap sx={{ flexShrink: 0, color: statusColor }}>
                  {status}
                </Typography>
              </Stack>
              {subtitleNode}
            </>
          )}
        </Box>
        {centeredStatus ? (
          <Typography variant="caption" noWrap sx={{ flexShrink: 0, color: statusColor }}>
            {status}
          </Typography>
        ) : null}
      </Stack>
      {footer}
      {actions}
    </Box>
  )
}

function cardSx(compact: boolean): SxProps<Theme> {
  return {
    border: 1,
    borderColor: 'divider',
    borderRadius: 2,
    px: compact ? 1.25 : 1,
    py: compact ? 0.75 : 1,
    mb: compact ? 0 : 0.9,
    height: compact ? 44 : 68,
    boxSizing: 'border-box',
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    overflow: 'hidden',
    minWidth: 0,
    cursor: 'pointer',
    bgcolor: 'background.paper',
    boxShadow: '0 2px 5px rgba(18, 35, 43, 0.05), 0 8px 20px rgba(18, 35, 43, 0.04)',
    transition: 'transform 200ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 200ms ease',
    '&:hover': {
      transform: 'translateY(-1px)',
      boxShadow: '0 4px 10px rgba(18, 35, 43, 0.09), 0 12px 25px rgba(18, 35, 43, 0.06)'
    },
    '@media (prefers-reduced-motion: reduce)': {
      transition: 'none',
      '&:hover': { transform: 'none' }
    },
    '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 1 }
  }
}
