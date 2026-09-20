import { Box, Collapse, IconButton, Tooltip, Typography } from '@mui/material'
import { memo, useMemo, useState } from 'react'
import { PhiIcons } from '../icons'
import type { NotebookCellJumpTarget, ToolCallItem } from '../types'
import { toolActionKind } from '../lib/toolActions'
import { diffStat } from '../lib/toolOutput'
import { ToolActionIcon } from './ToolActionIcon'
import { notebookHeadline, notebookJumpTarget } from './tool-call/notebookToolSummaryModel'
import { StatusIndicator } from './tool-call/StatusIndicator'
import { ToolCallDetail } from './tool-call/ToolCallDetail'
import {
  useCollapseResizeNotifier,
  type ChatContentResizeHandler
} from './chat/useCollapseResizeNotifier'

export { StatusIndicator } from './tool-call/StatusIndicator'
export { ToolCallDetail } from './tool-call/ToolCallDetail'

const ChevronRightIcon = PhiIcons.action.back

function foldedToolHeadline(item: ToolCallItem, action: ReturnType<typeof toolActionKind>): string {
  const notebook = notebookHeadline(item)
  if (notebook) return notebook
  if (action === 'python') return '执行 Python 代码'
  if (action === 'command') return '执行命令'
  return item.argsPreview || item.toolName
}

type ToolCallCardProps = {
  item: ToolCallItem
  /**
   * Controlled expansion, for a card whose owner decides when it is open (a step of a delegated
   * agent opens while it runs). Without it the card keeps its own state, folded to start with.
   */
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
  cwd?: string
  onJumpToNotebookCell?: (target: NotebookCellJumpTarget) => void
  onContentResize?: ChatContentResizeHandler
}

function ToolCallCard({
  item,
  expanded: controlledExpanded,
  onExpandedChange,
  cwd,
  onJumpToNotebookCell,
  onContentResize
}: ToolCallCardProps): React.JSX.Element {
  const [ownExpanded, setOwnExpanded] = useState(false)
  const expanded = controlledExpanded ?? ownExpanded
  const stat = useMemo(() => (item.output ? diffStat(item.output) : null), [item.output])
  const notifyContentResize = useCollapseResizeNotifier(onContentResize)
  const toggle = (): void => {
    if (controlledExpanded === undefined) setOwnExpanded(!expanded)
    onExpandedChange?.(!expanded)
    notifyContentResize()
  }
  const action = toolActionKind(item.toolName, item.argsPreview, item.argsJson)
  const headline = foldedToolHeadline(item, action)
  const showToolName = action !== 'command' && action !== 'python' && action !== 'notebook'
  const jumpTarget = notebookJumpTarget(item.notebook)

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
        <ToolActionIcon action={action} />
        {showToolName ? (
          <Typography
            component="span"
            variant="body2"
            sx={{ fontFamily: 'var(--font-mono)', color: 'text.primary', flexShrink: 0 }}
          >
            {item.toolName}
          </Typography>
        ) : null}
        <Typography
          component="span"
          variant="body2"
          noWrap
          sx={{
            fontFamily: showToolName ? 'var(--font-mono)' : 'inherit',
            flex: 1,
            minWidth: 0
          }}
        >
          {headline}
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
        {jumpTarget && onJumpToNotebookCell ? (
          <Tooltip title="跳转到 cell" enterDelay={400}>
            <IconButton
              size="small"
              aria-label="跳转到 cell"
              onClick={(event) => {
                event.stopPropagation()
                onJumpToNotebookCell(jumpTarget)
              }}
              sx={{
                width: 26,
                height: 26,
                flexShrink: 0,
                color: 'primary.main',
                bgcolor: 'background.paper',
                '&:hover': { bgcolor: 'action.hover' }
              }}
            >
              <PhiIcons.nav.analysis sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        ) : null}
        <Box
          aria-live={item.status === 'running' ? 'polite' : undefined}
          sx={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}
        >
          <StatusIndicator status={item.status} />
        </Box>
      </Box>
      <Collapse
        in={expanded}
        unmountOnExit
        onEnter={notifyContentResize}
        onEntering={notifyContentResize}
        onEntered={notifyContentResize}
        onExit={notifyContentResize}
        onExiting={notifyContentResize}
        onExited={notifyContentResize}
      >
        <ToolCallDetail item={item} cwd={cwd} />
      </Collapse>
    </Box>
  )
}

// `item` keeps a stable object reference across reducer updates for every
// tool call that isn't the one currently being mutated, so comparing by
// reference is enough to skip re-rendering unrelated tool cards while a
// sibling tool call/message is still streaming in.
function toolCallCardPropsEqual(prev: ToolCallCardProps, next: ToolCallCardProps): boolean {
  return (
    prev.item === next.item &&
    prev.cwd === next.cwd &&
    prev.expanded === next.expanded &&
    prev.onExpandedChange === next.onExpandedChange
  )
}

export default memo(ToolCallCard, toolCallCardPropsEqual)
