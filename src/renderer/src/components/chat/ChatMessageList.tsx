import { Alert, AlertTitle, Box, Button, Collapse, IconButton, Typography } from '@mui/material'
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import MarkdownContent, { type LocalPathKind } from '../MarkdownContent'
import ToolCallCard, { StatusIndicator } from '../ToolCallCard'
import ToolGroupCard from '../ToolGroupCard'
import { WrapperPlanCard } from '../../features/wrapper/components/WrapperPlanCard'
import { PhiIcons } from '../../icons'
import { getProviderErrorDisplay } from '../../lib/providerErrors'
import {
  groupMessages,
  groupProcessingItems,
  processingGroupStatus,
  processingStatusText,
  timestampMs,
  type ProcessingItem,
  type RenderGroup
} from '../../lib/chatRenderGroups'
import {
  chatVirtualWindow,
  normalizedChatVirtualRowHeight,
  type ChatVirtualItem,
  type ChatVirtualViewport
} from '../../lib/chatVirtualization'
import type { ChatItem, ChatMessage, NotebookCellJumpTarget } from '../../types'
import { ThinkingBlock } from './ThinkingBlock'
import { ChatUserMessage } from './ChatUserMessage'
import {
  useCollapseResizeNotifier,
  type ChatContentResizeHandler,
  type ChatContentResizeOptions
} from './useCollapseResizeNotifier'

const ChevronRightIcon = PhiIcons.action.back
const ExpandLessIcon = PhiIcons.action.collapse
const JumpToLatestIcon = PhiIcons.action.expand
const BOTTOM_STICKINESS_THRESHOLD_PX = 48
const USER_RESIZE_AUTO_SCROLL_SUPPRESSION_MS = 700

function distanceFromMessagesBottom(element: HTMLDivElement): number {
  return element.scrollHeight - element.scrollTop - element.clientHeight
}

function isNearMessagesBottom(element: HTMLDivElement): boolean {
  return distanceFromMessagesBottom(element) <= BOTTOM_STICKINESS_THRESHOLD_PX
}

function messagesCanScroll(element: HTMLDivElement): boolean {
  return element.scrollHeight - element.clientHeight > BOTTOM_STICKINESS_THRESHOLD_PX
}

function scrollMessagesElementToBottom(
  element: HTMLDivElement,
  behavior: ScrollBehavior = 'auto'
): void {
  if (typeof element.scrollTo === 'function') {
    element.scrollTo({ top: element.scrollHeight, behavior })
    return
  }
  element.scrollTop = element.scrollHeight
}

type MessageScrollMarker = {
  firstId: string | null
  lastId: string | null
  lastRole: ChatItem['role'] | null
  length: number
}

function messageScrollMarker(messages: ChatItem[]): MessageScrollMarker {
  const first = messages[0] ?? null
  const last = messages[messages.length - 1] ?? null
  return {
    firstId: first?.id ?? null,
    lastId: last?.id ?? null,
    lastRole: last?.role ?? null,
    length: messages.length
  }
}

type ChatGroupVirtualItem = ChatVirtualItem & { group: RenderGroup }

// Matches the vertical rhythm the previous flex `gap: 2` (16px) gave every
// group — moved onto each row's own top padding so a row's measured height
// (used for virtual-window math) includes the gap that follows it.
const CHAT_VIRTUAL_ROW_GAP_PT = 2

function chatVirtualListScrollTop(
  scrollViewport: HTMLElement,
  virtualList: HTMLElement | null
): number {
  if (!virtualList) return 0
  const viewportRect = scrollViewport.getBoundingClientRect()
  const listRect = virtualList.getBoundingClientRect()
  return Math.max(0, scrollViewport.scrollTop + listRect.top - viewportRect.top)
}

function ChatVirtualRowShell({
  groupKey,
  index,
  onMeasure,
  children
}: {
  groupKey: string
  index: number
  onMeasure: (groupKey: string, element: HTMLDivElement | null) => void
  children: ReactNode
}): ReactNode {
  const onRowRef = useCallback(
    (element: HTMLDivElement | null) => onMeasure(groupKey, element),
    [groupKey, onMeasure]
  )

  return (
    <Box ref={onRowRef} sx={{ pt: index === 0 ? 0 : CHAT_VIRTUAL_ROW_GAP_PT, minWidth: 0 }}>
      {children}
    </Box>
  )
}

function sameItemsByReference<T>(a: T[], b: T[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

type ProcessingGroupProps = {
  items: ProcessingItem[]
  onGoSettings: () => void
  onOpenLocalPath?: (path: string, pathKind: LocalPathKind) => void
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
// while a sibling message is still streaming. Function props are intentionally
// excluded: they're recreated by parent renders but don't capture render-local
// state that would go stale.
function processingGroupPropsEqual(
  prev: ProcessingGroupProps,
  next: ProcessingGroupProps
): boolean {
  return (
    sameItemsByReference(prev.items, next.items) &&
    prev.cwd === next.cwd &&
    prev.isActive === next.isActive &&
    prev.startedAtMs === next.startedAtMs &&
    prev.completedAtMs === next.completedAtMs &&
    prev.durationMs === next.durationMs
  )
}

const ProcessingGroup = memo(function ProcessingGroup({
  items,
  onGoSettings,
  onOpenLocalPath,
  onJumpToNotebookCell,
  onContentResize,
  cwd = '',
  isActive = false,
  startedAtMs,
  completedAtMs,
  durationMs
}: ProcessingGroupProps): ReactNode {
  const [expanded, setExpanded] = useState(false)
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
        <Box sx={{ ml: 2.5, pl: 1.5, minWidth: 0, borderLeft: 2, borderColor: 'grey.800' }}>
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
                  <ProcessingGroup
                    key={group.key}
                    items={group.items}
                    onGoSettings={onGoSettings}
                    onOpenLocalPath={onOpenLocalPath}
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
              if (group.item.role === 'wrapper_plan') {
                return <WrapperPlanCard key={group.key} item={group.item} />
              }
              return (
                <ChatBubble
                  key={group.key}
                  message={group.item}
                  onGoSettings={onGoSettings}
                  onOpenLocalPath={onOpenLocalPath}
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
        </Box>
      </Collapse>
    </Box>
  )
}, processingGroupPropsEqual)

type ChatBubbleProps = {
  message: ChatMessage
  onGoSettings: () => void
  onOpenLocalPath?: (path: string, pathKind: LocalPathKind) => void
  onContentResize?: ChatContentResizeHandler
  cwd?: string
}

// `message` keeps a stable object reference across reducer updates for every
// item that isn't the one currently being mutated (see agentEventReducer's
// `next[index] = { ...current, ... }` update), so a reference check here is
// enough to skip re-rendering (and re-parsing markdown for) every past
// message while the latest one streams in.
function chatBubblePropsEqual(prev: ChatBubbleProps, next: ChatBubbleProps): boolean {
  return prev.message === next.message && prev.cwd === next.cwd
}

const ChatBubble = memo(function ChatBubble({
  message,
  onGoSettings,
  onOpenLocalPath,
  onContentResize,
  cwd = ''
}: ChatBubbleProps): ReactNode {
  if (message.role === 'error') {
    const display = getProviderErrorDisplay(message.content)
    return (
      <Alert
        severity="error"
        variant="outlined"
        action={
          display.action === 'providerSettings' ? (
            <Button size="small" color="inherit" onClick={onGoSettings} sx={{ minHeight: 44 }}>
              {display.actionLabel}
            </Button>
          ) : undefined
        }
      >
        <AlertTitle>{display.title}</AlertTitle>
        <Typography variant="body2" sx={{ color: 'inherit', mb: 0.75 }}>
          {display.description}
        </Typography>
        {display.showRawMessage ? (
          <Typography variant="body2" sx={{ color: 'inherit', whiteSpace: 'pre-wrap' }}>
            原始错误：{display.rawMessage}
          </Typography>
        ) : null}
      </Alert>
    )
  }

  if (message.role === 'warning') {
    return (
      <Alert severity="info" variant="outlined">
        <Typography variant="body2" sx={{ color: 'inherit', whiteSpace: 'pre-wrap' }}>
          {message.content}
        </Typography>
      </Alert>
    )
  }

  if (message.role === 'thinking') {
    return (
      <ThinkingBlock
        content={message.content}
        durationMs={message.durationMs}
        onContentResize={onContentResize}
      />
    )
  }

  if (message.role === 'user') {
    return <ChatUserMessage message={message} />
  }

  return (
    <Box sx={{ alignSelf: 'stretch', minWidth: 0, px: 0.5 }}>
      <MarkdownContent text={message.content} cwd={cwd} onOpenLocalPath={onOpenLocalPath} />
    </Box>
  )
}, chatBubblePropsEqual)

export type ChatMessageListProps = {
  messages: ChatItem[]
  messagesContainerRef?: (node: HTMLDivElement | null) => void
  scrollResetKey?: string
  isGenerating: boolean
  currentRunStartedAt?: string
  onGoSettings: () => void
  onOpenLocalPath?: (path: string, pathKind: LocalPathKind) => void
  onJumpToNotebookCell?: (target: NotebookCellJumpTarget) => void
  cwd?: string
}

const ChatMessageList = memo(function ChatMessageList({
  messages,
  messagesContainerRef,
  scrollResetKey,
  isGenerating,
  currentRunStartedAt,
  onGoSettings,
  onOpenLocalPath,
  onJumpToNotebookCell,
  cwd = ''
}: ChatMessageListProps): React.JSX.Element {
  const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(null)
  const [showJumpToLatest, setShowJumpToLatest] = useState(false)
  // Mirrors stickToBottomRef for the one place (the virtualCells memo below)
  // that needs to react to it during render — refs can't be read there, only
  // in effects/callbacks. The ref stays the source of truth for synchronous
  // reads (e.g. inside onMessagesContentResize) where waiting for a re-render
  // would be too late.
  const [isStuckToBottom, setIsStuckToBottom] = useState(true)
  const stickToBottomRef = useRef(true)
  const suppressAutoScrollUntilRef = useRef(0)
  const lastMessageMarkerRef = useRef<MessageScrollMarker | null>(null)
  const virtualListRef = useRef<HTMLDivElement | null>(null)
  const virtualRowObserversRef = useRef<Map<string, ResizeObserver>>(new Map())
  const currentMessageMarker = useMemo(() => messageScrollMarker(messages), [messages])
  const renderGroups = useMemo(
    () => groupMessages(messages, { activeRun: isGenerating }),
    [isGenerating, messages]
  )
  const virtualItems = useMemo<ChatGroupVirtualItem[]>(
    () => renderGroups.map((group) => ({ id: group.key, group })),
    [renderGroups]
  )

  const [virtualViewport, setVirtualViewport] = useState<ChatVirtualViewport>({
    scrollTop: 0,
    viewportHeight: 0
  })
  const [virtualRowHeightState, setVirtualRowHeightState] = useState<{
    resetKey: string | undefined
    heights: Record<string, number>
  }>({ resetKey: scrollResetKey, heights: {} })
  const virtualRowHeights = useMemo(
    () => (virtualRowHeightState.resetKey === scrollResetKey ? virtualRowHeightState.heights : {}),
    [scrollResetKey, virtualRowHeightState]
  )

  const rawVirtualCells = useMemo(
    () => chatVirtualWindow(virtualItems, virtualRowHeights, virtualViewport),
    [virtualItems, virtualRowHeights, virtualViewport]
  )
  // While stuck to the bottom (the common case for an in-progress or freshly
  // opened conversation), force the window to include the last group even
  // before a real scrollTop has been measured (e.g. on first mount) or before
  // the scroll-driven sync below has caught up with a just-appended message —
  // otherwise the reader would briefly see the top of a long conversation
  // instead of the newest message.
  const virtualCells = useMemo(() => {
    if (!isStuckToBottom || rawVirtualCells.endIndex >= virtualItems.length) {
      return rawVirtualCells
    }
    return chatVirtualWindow(virtualItems, virtualRowHeights, {
      scrollTop: rawVirtualCells.totalHeight,
      viewportHeight: virtualViewport.viewportHeight
    })
  }, [
    isStuckToBottom,
    rawVirtualCells,
    virtualItems,
    virtualRowHeights,
    virtualViewport.viewportHeight
  ])

  const measureVirtualRow = useCallback(
    (groupKey: string, element: HTMLDivElement | null): void => {
      const existingObserver = virtualRowObserversRef.current.get(groupKey)
      if (existingObserver) {
        existingObserver.disconnect()
        virtualRowObserversRef.current.delete(groupKey)
      }
      if (!element) return

      const updateHeight = (): void => {
        const height = normalizedChatVirtualRowHeight(element.getBoundingClientRect().height)
        setVirtualRowHeightState((current) => {
          const currentHeights = current.resetKey === scrollResetKey ? current.heights : {}
          if (current.resetKey === scrollResetKey && currentHeights[groupKey] === height) {
            return current
          }
          return { resetKey: scrollResetKey, heights: { ...currentHeights, [groupKey]: height } }
        })
      }
      updateHeight()

      if (typeof ResizeObserver === 'undefined') return
      const observer = new ResizeObserver(updateHeight)
      observer.observe(element)
      virtualRowObserversRef.current.set(groupKey, observer)
    },
    [scrollResetKey]
  )

  useEffect(() => {
    const observers = virtualRowObserversRef.current
    return () => {
      for (const observer of observers.values()) observer.disconnect()
      observers.clear()
    }
  }, [])

  const updateScrollState = useCallback(
    (node = scrollContainer): void => {
      if (!node) return
      const isNearBottom = isNearMessagesBottom(node)
      stickToBottomRef.current = isNearBottom
      setIsStuckToBottom(isNearBottom)
      setShowJumpToLatest(!isNearBottom && messagesCanScroll(node))

      const listTop = chatVirtualListScrollTop(node, virtualListRef.current)
      const nextViewport = {
        scrollTop: Math.max(0, node.scrollTop - listTop),
        viewportHeight: node.clientHeight
      }
      setVirtualViewport((current) =>
        current.scrollTop === nextViewport.scrollTop &&
        current.viewportHeight === nextViewport.viewportHeight
          ? current
          : nextViewport
      )
    },
    [scrollContainer]
  )

  const scrollToLatest = useCallback(
    (behavior: ScrollBehavior = 'auto'): void => {
      if (!scrollContainer) return
      scrollMessagesElementToBottom(scrollContainer, behavior)
      stickToBottomRef.current = true
      setIsStuckToBottom(true)
      setShowJumpToLatest(false)
    },
    [scrollContainer]
  )

  const onMessagesContentResize = useCallback(
    (options?: ChatContentResizeOptions): void => {
      if (!scrollContainer) return

      if (options?.preserveScrollPosition && !stickToBottomRef.current) {
        suppressAutoScrollUntilRef.current = Date.now() + USER_RESIZE_AUTO_SCROLL_SUPPRESSION_MS
        updateScrollState(scrollContainer)
        return
      }

      if (stickToBottomRef.current && Date.now() >= suppressAutoScrollUntilRef.current) {
        scrollToLatest()
        return
      }

      updateScrollState(scrollContainer)
    },
    [scrollContainer, scrollToLatest, updateScrollState]
  )

  const handleMessagesContainerRef = useCallback(
    (node: HTMLDivElement | null): void => {
      setScrollContainer(node)
      messagesContainerRef?.(node)
    },
    [messagesContainerRef]
  )

  const handleMessagesScroll = useCallback((): void => {
    updateScrollState()
  }, [updateScrollState])

  const handleJumpToLatest = useCallback((): void => {
    scrollToLatest()
  }, [scrollToLatest])

  useEffect(() => {
    lastMessageMarkerRef.current = null
    stickToBottomRef.current = true
    suppressAutoScrollUntilRef.current = 0
    if (!scrollContainer) return undefined

    const frame = window.requestAnimationFrame(() => scrollToLatest())
    return () => window.cancelAnimationFrame(frame)
  }, [scrollContainer, scrollResetKey, scrollToLatest])

  useEffect(() => {
    if (!scrollContainer) {
      lastMessageMarkerRef.current = currentMessageMarker
      return undefined
    }

    const previousMarker = lastMessageMarkerRef.current
    lastMessageMarkerRef.current = currentMessageMarker
    const replacedMessages =
      !previousMarker ||
      (previousMarker.length > 0 && previousMarker.firstId !== currentMessageMarker.firstId)
    const userSubmittedMessage =
      currentMessageMarker.lastRole === 'user' &&
      currentMessageMarker.lastId !== previousMarker?.lastId

    if (replacedMessages || userSubmittedMessage || stickToBottomRef.current) {
      const frame = window.requestAnimationFrame(() => scrollToLatest())
      return () => window.cancelAnimationFrame(frame)
    }

    updateScrollState(scrollContainer)
    return undefined
  }, [currentMessageMarker, scrollContainer, scrollToLatest, updateScrollState])

  useEffect(() => {
    if (!scrollContainer || typeof ResizeObserver === 'undefined') {
      return undefined
    }

    const content = scrollContainer.firstElementChild
    if (!content) return undefined

    let frame: number | null = null
    const scheduleResize = (): void => {
      if (frame !== null) {
        window.cancelAnimationFrame(frame)
      }
      frame = window.requestAnimationFrame(() => {
        frame = null
        onMessagesContentResize()
      })
    }
    const observer = new ResizeObserver(scheduleResize)
    observer.observe(content)

    return () => {
      if (frame !== null) {
        window.cancelAnimationFrame(frame)
      }
      observer.disconnect()
    }
  }, [onMessagesContentResize, scrollContainer])

  const renderGroup = useCallback(
    (group: RenderGroup, absoluteIndex: number): ReactNode => {
      if (group.kind === 'tool-group') {
        return (
          <ToolGroupCard
            items={group.items}
            cwd={cwd}
            onJumpToNotebookCell={onJumpToNotebookCell}
            onContentResize={onMessagesContentResize}
          />
        )
      }
      if (group.kind === 'processing-group') {
        const isActiveProcessingGroup = isGenerating && absoluteIndex === renderGroups.length - 1
        return (
          <ProcessingGroup
            items={group.items}
            onGoSettings={onGoSettings}
            onOpenLocalPath={onOpenLocalPath}
            onJumpToNotebookCell={onJumpToNotebookCell}
            onContentResize={onMessagesContentResize}
            cwd={cwd}
            isActive={isActiveProcessingGroup}
            startedAtMs={
              isActiveProcessingGroup
                ? (timestampMs(currentRunStartedAt) ?? group.startedAtMs)
                : group.startedAtMs
            }
            completedAtMs={group.completedAtMs}
            durationMs={group.durationMs}
          />
        )
      }
      if (group.item.role === 'tool') {
        return (
          <ToolCallCard
            item={group.item}
            cwd={cwd}
            onJumpToNotebookCell={onJumpToNotebookCell}
            onContentResize={onMessagesContentResize}
          />
        )
      }
      if (group.item.role === 'wrapper_plan') {
        return <WrapperPlanCard item={group.item} />
      }
      return (
        <ChatBubble
          message={group.item}
          onGoSettings={onGoSettings}
          onOpenLocalPath={onOpenLocalPath}
          onContentResize={onMessagesContentResize}
          cwd={cwd}
        />
      )
    },
    [
      cwd,
      currentRunStartedAt,
      isGenerating,
      onGoSettings,
      onJumpToNotebookCell,
      onMessagesContentResize,
      onOpenLocalPath,
      renderGroups.length
    ]
  )

  return (
    <Box sx={{ flex: 1, minHeight: 0, minWidth: 0, position: 'relative' }}>
      <Box
        ref={handleMessagesContainerRef}
        onScroll={handleMessagesScroll}
        sx={{ height: '100%', minWidth: 0, overflowY: 'auto', overflowX: 'hidden' }}
      >
        <Box
          ref={virtualListRef}
          sx={{
            maxWidth: 860,
            mx: 'auto',
            minWidth: 0,
            px: 3,
            pt: 3,
            pb: isGenerating ? 6 : 3
          }}
        >
          {virtualCells.beforeHeight > 0 ? (
            <Box aria-hidden="true" sx={{ height: virtualCells.beforeHeight }} />
          ) : null}
          {virtualCells.items.map(({ item, index }) => (
            <ChatVirtualRowShell
              key={item.group.key}
              groupKey={item.group.key}
              index={index}
              onMeasure={measureVirtualRow}
            >
              {renderGroup(item.group, index)}
            </ChatVirtualRowShell>
          ))}
          {virtualCells.afterHeight > 0 ? (
            <Box aria-hidden="true" sx={{ height: virtualCells.afterHeight }} />
          ) : null}
        </Box>
      </Box>
      {showJumpToLatest ? (
        <IconButton
          aria-label="回到最新消息"
          onClick={handleJumpToLatest}
          sx={{
            position: 'absolute',
            left: '50%',
            bottom: 12,
            transform: 'translateX(-50%)',
            width: 36,
            height: 36,
            zIndex: 2,
            color: 'primary.main',
            bgcolor: 'background.paper',
            border: 1,
            borderColor: 'divider',
            boxShadow: 2,
            '&:hover': {
              bgcolor: 'background.paper',
              borderColor: 'primary.main',
              boxShadow: 3
            }
          }}
        >
          <JumpToLatestIcon fontSize="small" />
        </IconButton>
      ) : null}
    </Box>
  )
})

export default ChatMessageList
