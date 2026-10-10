import { Box, Collapse, IconButton, Typography } from '@mui/material'
import { memo, useEffect, useState, type ReactNode } from 'react'
import AgentExecutionCard from '../AgentExecutionCard'
import { type LocalPathKind } from '../MarkdownContent'
import ToolCallCard, { StatusIndicator } from '../ToolCallCard'
import ToolGroupCard from '../ToolGroupCard'
import { WrapperPlanCard } from '../../features/wrapper/components/WrapperPlanCard'
import { WorkspaceChangesCard } from '../../features/chat/components/WorkspaceChangesCard'
import { PresentedFilesCard } from '../../features/chat/components/PresentedFilesCard'
import { UiBlocksCard } from '../../features/chat/components/UiBlocks/UiBlocksCard'
import { PlanReviewCard } from '../../features/chat/components/PlanReviewCard'
import { PhiIcons } from '../../icons'
import {
  groupProcessingItems,
  processingGroupStatus,
  processingStatusText,
  type ProcessingItem
} from '../../lib/chatRenderGroups'
import type { NotebookCellJumpTarget } from '../../types'
import { ChatBubble } from './ChatBubble'
import { TimelineRail } from './TimelineRail'
import {
  useCollapseResizeNotifier,
  type ChatContentResizeHandler
} from './useCollapseResizeNotifier'

const ChevronRightIcon = PhiIcons.action.back
const ExpandLessIcon = PhiIcons.action.collapse

function sameItemsByReference<T>(a: T[], b: T[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/** Asks the conversation to show one item: the fold holding it opens, the list scrolls to it. */
export type ChatFocusRequest = { itemId: string; nonce: number }

export type ChatProcessingGroupProps = {
  items: ProcessingItem[]
  /** Opens this fold when the item being located is inside it. */
  focusRequest?: ChatFocusRequest | null
  onGoSettings: () => void
  onOpenBackgroundJobs: () => void
  onOpenLocalPath?: (path: string, pathKind: LocalPathKind) => void
  onOpenWebUrl?: (url: string) => void
  onJumpToNotebookCell?: (target: NotebookCellJumpTarget) => void
  onContentResize?: ChatContentResizeHandler
  cwd?: string
  isActive?: boolean
  startedAtMs?: number
  completedAtMs?: number
  durationMs?: number
}

// groupMessages/groupProcessingItems rebuild group wrapper objects (and their
// `items` arrays) on every call, even when the underlying ChatItem objects are
// unchanged. Comparing item-by-item reference equality (instead of the default
// shallow array-reference check) lets an unrelated group skip re-rendering
// while a sibling message is still streaming. The local-path opener is included
// because Markdown links depend on it without changing the message items.
function processingGroupPropsEqual(
  prev: ChatProcessingGroupProps,
  next: ChatProcessingGroupProps
): boolean {
  return (
    sameItemsByReference(prev.items, next.items) &&
    prev.focusRequest === next.focusRequest &&
    prev.onOpenBackgroundJobs === next.onOpenBackgroundJobs &&
    prev.onOpenLocalPath === next.onOpenLocalPath &&
    prev.onOpenWebUrl === next.onOpenWebUrl &&
    prev.cwd === next.cwd &&
    prev.isActive === next.isActive &&
    prev.startedAtMs === next.startedAtMs &&
    prev.completedAtMs === next.completedAtMs &&
    prev.durationMs === next.durationMs
  )
}

export const ChatProcessingGroup = memo(function ChatProcessingGroup({
  items,
  focusRequest = null,
  onGoSettings,
  onOpenBackgroundJobs,
  onOpenLocalPath,
  onOpenWebUrl,
  onJumpToNotebookCell,
  onContentResize,
  cwd = '',
  isActive = false,
  startedAtMs,
  completedAtMs,
  durationMs
}: ChatProcessingGroupProps): ReactNode {
  const [expanded, setExpanded] = useState(false)
  // Adjusting state while rendering (not in an effect) opens the fold in the same pass that
  // receives the request, so the card is mounted by the time the list goes looking for it.
  const [handledFocusNonce, setHandledFocusNonce] = useState(0)
  if (
    focusRequest &&
    focusRequest.nonce !== handledFocusNonce &&
    items.some((item) => item.id === focusRequest.itemId)
  ) {
    setHandledFocusNonce(focusRequest.nonce)
    setExpanded(true)
  }
  const [fallbackStartedAtMs] = useState(() => Date.now())
  const [nowMs, setNowMs] = useState(() => Date.now())
  const notifyContentResize = useCollapseResizeNotifier(onContentResize)
  const toggle = (): void => {
    setExpanded((value) => !value)
    notifyContentResize()
  }
  const groupedItems = groupProcessingItems(items)
  const status = processingGroupStatus(items, isActive)
  const isProcessingActive = status === 'running'
  const summary = processingStatusText({
    items,
    isActive: isProcessingActive,
    nowMs,
    fallbackStartedAtMs,
    startedAtMs,
    completedAtMs,
    durationMs
  })

  useEffect(() => {
    if (!isProcessingActive) return undefined
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [isProcessingActive])

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
        aria-label={expanded ? '折叠处理过程' : '展开处理过程'}
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
        <Typography component="span" variant="body2" noWrap sx={{ flex: 1, minWidth: 0 }}>
          {summary}
        </Typography>
        {status ? (
          <Box sx={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
            <StatusIndicator status={status} />
          </Box>
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
        <TimelineRail active={isProcessingActive}>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, py: 0.5 }}>
            {groupedItems.map((group) => {
              if (group.kind === 'tool-group') {
                return (
                  <ToolGroupCard
                    key={group.key}
                    items={group.items}
                    cwd={cwd}
                    onJumpToNotebookCell={onJumpToNotebookCell}
                    onContentResize={onContentResize}
                  />
                )
              }
              if (group.kind === 'processing-group') {
                return (
                  <ChatProcessingGroup
                    key={group.key}
                    items={group.items}
                    onGoSettings={onGoSettings}
                    onOpenBackgroundJobs={onOpenBackgroundJobs}
                    onOpenLocalPath={onOpenLocalPath}
                    onOpenWebUrl={onOpenWebUrl}
                    onJumpToNotebookCell={onJumpToNotebookCell}
                    onContentResize={onContentResize}
                    cwd={cwd}
                    isActive={false}
                    startedAtMs={group.startedAtMs}
                    completedAtMs={group.completedAtMs}
                    durationMs={group.durationMs}
                  />
                )
              }
              if (group.item.role === 'tool') {
                return (
                  <ToolCallCard
                    key={group.key}
                    item={group.item}
                    cwd={cwd}
                    onJumpToNotebookCell={onJumpToNotebookCell}
                    onContentResize={onContentResize}
                  />
                )
              }
              if (group.item.role === 'agent_execution') {
                return (
                  <AgentExecutionCard
                    key={group.key}
                    item={group.item}
                    cwd={cwd}
                    onOpenLocalPath={onOpenLocalPath}
                    onContentResize={onContentResize}
                  />
                )
              }
              if (group.item.role === 'wrapper_plan') {
                return <WrapperPlanCard key={group.key} item={group.item} />
              }
              if (group.item.role === 'workspace_changes') {
                return (
                  <WorkspaceChangesCard
                    key={group.key}
                    item={group.item}
                    onOpenFile={
                      onOpenLocalPath ? (path) => onOpenLocalPath(path, 'file') : undefined
                    }
                  />
                )
              }
              if (group.item.role === 'presented_files') {
                return (
                  <PresentedFilesCard
                    key={group.key}
                    item={group.item}
                    onOpenFile={
                      onOpenLocalPath ? (path) => onOpenLocalPath(path, 'file') : undefined
                    }
                  />
                )
              }
              if (group.item.role === 'ui_blocks') {
                return <UiBlocksCard key={group.key} item={group.item} />
              }
              if (group.item.role === 'plan_review') {
                return <PlanReviewCard key={group.key} item={group.item} cwd={cwd} />
              }
              return (
                <ChatBubble
                  key={group.key}
                  message={group.item}
                  onGoSettings={onGoSettings}
                  onOpenBackgroundJobs={onOpenBackgroundJobs}
                  onOpenLocalPath={onOpenLocalPath}
                  onOpenWebUrl={onOpenWebUrl}
                  onContentResize={onContentResize}
                  cwd={cwd}
                />
              )
            })}
          </Box>
          <Box sx={{ display: 'flex', justifyContent: 'flex-start', pb: 0.5 }}>
            <IconButton
              size="small"
              aria-label="折叠处理过程"
              title="折叠处理过程"
              onClick={toggle}
              sx={{
                width: 28,
                height: 28,
                color: 'text.secondary'
              }}
            >
              <ExpandLessIcon fontSize="small" />
            </IconButton>
          </Box>
        </TimelineRail>
      </Collapse>
    </Box>
  )
}, processingGroupPropsEqual)
