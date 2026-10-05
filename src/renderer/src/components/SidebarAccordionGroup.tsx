import { Accordion, AccordionDetails, AccordionSummary, Box, Typography } from '@mui/material'
import type { ReactNode, Ref } from 'react'
import { PhiIcons } from '../icons'

const ExpandIcon = PhiIcons.action.expand

// Fixed header height — several sidebars compute the expanded body's
// max-height as "list height minus every header", so this must stay exact
// (not just a minHeight). Change it only together with those call sites.
export const SIDEBAR_GROUP_HEADER_HEIGHT = 40

const countBadgeSx = {
  ml: 0.75,
  px: 0.75,
  borderRadius: '6px',
  bgcolor: 'action.selected',
  color: 'text.secondary',
  fontSize: '0.6875rem',
  fontWeight: 700,
  lineHeight: '16px',
  flexShrink: 0
} as const

/**
 * The sidebar collapsible group shared by wrappers, skills and MCP
 * connectors: a borderless accordion with a fixed-height rounded hover
 * header (title + optional count badge) and an unpadded body that can
 * optionally cap its height and scroll on its own.
 */
export function SidebarAccordionGroup({
  expanded,
  onExpandedChange,
  title,
  count,
  leading,
  titleExtras,
  expandedBodyMaxHeight,
  detailsRef,
  children
}: {
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
  title: ReactNode
  count?: number
  /** Rendered before the title, e.g. a category marker dot. */
  leading?: ReactNode
  /** Rendered right after the title, e.g. a "built-in" icon. */
  titleExtras?: ReactNode
  /** When set, the expanded body caps at this height and scrolls itself. */
  expandedBodyMaxHeight?: number
  detailsRef?: Ref<HTMLDivElement>
  children: ReactNode
}): React.JSX.Element {
  return (
    <Accordion
      expanded={expanded}
      onChange={(_event, isExpanded) => onExpandedChange(isExpanded)}
      disableGutters
      elevation={0}
      slotProps={{
        transition: { timeout: { enter: 200, exit: 120 } }
      }}
      sx={{
        bgcolor: 'transparent',
        border: 0,
        // The catalog sidebar supplies the same gutter as its search field.
        px: 0,
        '&::before': { display: 'none' }
      }}
    >
      <AccordionSummary
        expandIcon={<ExpandIcon fontSize="small" />}
        sx={{
          height: SIDEBAR_GROUP_HEADER_HEIGHT,
          minHeight: `${SIDEBAR_GROUP_HEADER_HEIGHT}px !important`,
          px: 1.5,
          py: 0,
          borderRadius: 1,
          WebkitAppRegion: 'no-drag',
          transition: 'background-color 0.15s ease',
          '&:hover': { bgcolor: 'action.hover' },
          '& .MuiAccordionSummary-content': {
            alignItems: 'center',
            my: 0.5,
            minWidth: 0
          }
        }}
      >
        <Typography
          color={expanded ? 'text.primary' : 'text.secondary'}
          sx={{
            display: 'flex',
            alignItems: 'center',
            minWidth: 0,
            width: '100%',
            fontSize: '0.8125rem',
            fontWeight: 600,
            letterSpacing: '0.01em'
          }}
        >
          {leading}
          {title}
          {titleExtras}
          {count !== undefined ? (
            <Box component="span" sx={countBadgeSx}>
              {count}
            </Box>
          ) : null}
        </Typography>
      </AccordionSummary>
      <AccordionDetails
        ref={detailsRef}
        sx={{
          p: 0,
          WebkitAppRegion: 'no-drag',
          ...(expanded && expandedBodyMaxHeight !== undefined
            ? { maxHeight: expandedBodyMaxHeight, overflowY: 'auto' }
            : {})
        }}
      >
        {children}
      </AccordionDetails>
    </Accordion>
  )
}
