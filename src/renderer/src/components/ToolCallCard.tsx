import { chatCopy } from '../features/chat/lib/chatCopy'
import { nestedFoldChevronRevealSx } from '../features/chat/lib/nestedFoldChevronStyles'
import { useUiLanguage } from '../lib/i18n'
import { Box, Collapse, IconButton, Tooltip, Typography } from '@mui/material'
import { memo, useMemo, useState } from 'react'
import { PhiIcons } from '../icons'
import type { NotebookCellJumpTarget, ToolCallItem } from '../types'
import { toolActionKind } from '../lib/toolActions'
import { webToolSummary } from '../features/chat/lib/webToolSummary'
import { diffStat } from '../lib/toolOutput'
import { ToolActionIcon } from './ToolActionIcon'
import { notebookHeadline, notebookJumpTarget } from './tool-call/notebookToolSummaryModel'
import { StatusIndicator } from './tool-call/StatusIndicator'
import { ScrollableToolDetail } from './tool-call/ScrollableToolDetail'
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
  if (action === 'python') return chatCopy.executePythonCode
  if (action === 'command') return chatCopy.executeCommand
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
  /**
   * Caps the height of the arguments and output, which then scroll (and follow a running call's
   * output). Without it they take the room they need, as an ordinary tool call in the chat does.
   */
  detailMaxHeight?: number
  cwd?: string
  onJumpToNotebookCell?: (target: NotebookCellJumpTarget) => void
  onContentResize?: ChatContentResizeHandler
}

function ToolCallCard({
  item,
  expanded: controlledExpanded,
  onExpandedChange,
  detailMaxHeight,
  cwd,
  onJumpToNotebookCell,
  onContentResize
}: ToolCallCardProps): React.JSX.Element {
  useUiLanguage()
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
  const headline =
    webToolSummary(item.toolName, item.argsJson)?.headline ?? foldedToolHeadline(item, action)
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
          transition: 'color 150ms',
          ...nestedFoldChevronRevealSx,
          '&:hover': { color: 'text.primary' },
          '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' }
        }}
      >
        {item.status === 'done' ? (
          <ToolActionIcon action={action} />
        ) : (
          <Box
            aria-live={item.status === 'running' ? 'polite' : undefined}
            sx={{
              width: 18,
              height: 18,
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            <StatusIndicator status={item.status} />
          </Box>
        )}
        {showToolName ? (
          <Typography
            component="span"
            variant="body2"
            sx={{ fontFamily: 'var(--font-mono)', color: 'text.primary', flexShrink: 0 }}
          >
            {item.toolName}
          </Typography>
        ) : null}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flex: 1, minWidth: 0 }}>
          <Typography
            component="span"
            variant="body2"
            noWrap
            title={headline}
            sx={{
              fontFamily: showToolName ? 'var(--font-mono)' : 'inherit',
              flex: '0 1 auto',
              minWidth: 0
            }}
          >
            {headline}
          </Typography>
          <ChevronRightIcon
            className="phi-nested-fold-chevron"
            aria-hidden
            sx={{
              fontSize: 16,
              flexShrink: 0,
              transform: expanded ? 'rotate(90deg)' : 'none'
            }}
          />
        </Box>
        {stat ? (
          <Typography
            component="span"
            variant="caption"
            title={chatCopy.diffLineCountsValue(stat.added, stat.removed)}
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
          <Tooltip title={chatCopy.goToCell} enterDelay={400}>
            <IconButton
              size="small"
              aria-label={chatCopy.goToCell}
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
        {detailMaxHeight !== undefined ? (
          <ScrollableToolDetail
            maxHeight={detailMaxHeight}
            follow={item.status === 'running'}
            contentKey={item.output}
          >
            <ToolCallDetail item={item} cwd={cwd} />
          </ScrollableToolDetail>
        ) : (
          <ToolCallDetail item={item} cwd={cwd} />
        )}
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
    prev.onExpandedChange === next.onExpandedChange &&
    prev.detailMaxHeight === next.detailMaxHeight
  )
}

export default memo(ToolCallCard, toolCallCardPropsEqual)
