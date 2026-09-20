import { Box, IconButton } from '@mui/material'
import { alpha, useTheme } from '@mui/material/styles'
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { type LocalPathKind } from '../MarkdownContent'
import AgentExecutionCard from '../AgentExecutionCard'
import ToolCallCard from '../ToolCallCard'
import ToolGroupCard from '../ToolGroupCard'
import { WrapperPlanCard } from '../../features/wrapper/components/WrapperPlanCard'
import { PhiIcons } from '../../icons'
import {
  centeredScrollTop,
  groupIndexContainingItem,
  runningAgentRuns,
  virtualRowScrollTop
} from '../../lib/agentRunsOverview'
import { groupMessages, timestampMs, type RenderGroup } from '../../lib/chatRenderGroups'
import {
  chatVirtualWindow,
  normalizedChatVirtualRowHeight,
  type ChatVirtualItem,
  type ChatVirtualViewport
} from '../../lib/chatVirtualization'
import { useLostAgentRunsStore } from '../../stores/lostAgentRunsStore'
import type { ChatItem, ChatMessage, NotebookCellJumpTarget } from '../../types'
import AgentRunsOverview from './AgentRunsOverview'
import { ChatBubble } from './ChatBubble'
import { ChatProcessingGroup, type ChatFocusRequest } from './ChatProcessingGroup'
import { type UserMessageRetryTarget, type UserMessageState } from './ChatUserMessage'
import { type ChatContentResizeOptions } from './useCollapseResizeNotifier'

const JumpToLatestIcon = PhiIcons.action.expand
const BOTTOM_STICKINESS_THRESHOLD_PX = 48
const USER_RESIZE_AUTO_SCROLL_SUPPRESSION_MS = 700
// Locating a card opens a fold and scrolls; streaming output must not pull the view back meanwhile.
const AGENT_LOCATE_AUTOSCROLL_SUPPRESSION_MS = 1500
// The card may not be on screen yet: its row has to be scrolled into the virtual window and its
// fold opened first. ~1 s of frames is plenty; give up quietly after that.
const AGENT_LOCATE_MAX_FRAMES = 60
// A fold takes a moment to finish opening; centre once more after it has.
const AGENT_LOCATE_RECENTER_MS = 450
const AGENT_LOCATE_FLASH_MS = 1400

/** A brief outline on the card the user just asked to see. Skipped for users who avoid motion. */
function flashElement(element: HTMLElement, color: string): void {
  if (typeof element.animate !== 'function') return
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
  element.animate(
    [
      { boxShadow: `0 0 0 2px ${color}`, backgroundColor: alpha(color, 0.12) },
      { boxShadow: `0 0 0 2px ${alpha(color, 0)}`, backgroundColor: alpha(color, 0) }
    ],
    { duration: AGENT_LOCATE_FLASH_MS, easing: 'ease-out' }
  )
}

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

function failedUserMessageStates(messages: ChatItem[]): Map<string, UserMessageState> {
  const states = new Map<string, UserMessageState>()
  let currentUser: (ChatMessage & { role: 'user' }) | null = null
  let currentFailed = false

  const flushCurrentUser = (): void => {
    if (!currentUser) return
    states.set(currentUser.id, currentFailed ? 'failed' : 'normal')
  }

  for (const message of messages) {
    if (message.role === 'user') {
      flushCurrentUser()
      currentUser = message as ChatMessage & { role: 'user' }
      currentFailed = false
      continue
    }

    if (!currentUser) continue
    if (
      (message.role === 'run' && message.event === 'failed') ||
      (message.role === 'error' && message.runId)
    ) {
      currentFailed = true
    }
  }

  flushCurrentUser()
  return states
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
    <Box
      ref={onRowRef}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        pt: index === 0 ? 0 : CHAT_VIRTUAL_ROW_GAP_PT,
        minWidth: 0
      }}
    >
      {children}
    </Box>
  )
}

export type ChatMessageListProps = {
  messages: ChatItem[]
  messagesContainerRef?: (node: HTMLDivElement | null) => void
  scrollResetKey?: string
  isGenerating: boolean
  currentRunStartedAt?: string
  onEditUserMessage?: (content: string) => void
  onRetryUserMessage?: (message: UserMessageRetryTarget) => void
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
  onEditUserMessage,
  onRetryUserMessage,
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
  const [focusRequest, setFocusRequest] = useState<ChatFocusRequest | null>(null)
  const focusNonceRef = useRef(0)
  const primaryColor = useTheme().palette.primary.main
  const lostAgentRuns = useLostAgentRunsStore((state) => state.lost)
  const runningAgents = useMemo(
    () => runningAgentRuns(messages, lostAgentRuns),
    [messages, lostAgentRuns]
  )
  const virtualRowObserversRef = useRef<Map<string, ResizeObserver>>(new Map())
  const currentMessageMarker = useMemo(() => messageScrollMarker(messages), [messages])
  const renderGroups = useMemo(
    () => groupMessages(messages, { activeRun: isGenerating }),
    [isGenerating, messages]
  )
  const userMessageStates = useMemo(() => failedUserMessageStates(messages), [messages])
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

  // Brings an agent's card into view from the running-agents overview. The card usually sits in a
  // folded processing group inside a virtual list, so this asks the fold to open, scrolls the row
  // into the virtual window, then (below) centres the card once it exists.
  const locateAgentCard = useCallback(
    (itemId: string): void => {
      if (!scrollContainer) return
      const groupIndex = groupIndexContainingItem(renderGroups, itemId)
      if (groupIndex < 0) return
      // Leave the bottom on purpose: otherwise streaming would pull the view straight back.
      stickToBottomRef.current = false
      setIsStuckToBottom(false)
      suppressAutoScrollUntilRef.current = Date.now() + AGENT_LOCATE_AUTOSCROLL_SUPPRESSION_MS
      focusNonceRef.current += 1
      setFocusRequest({ itemId, nonce: focusNonceRef.current })
      const listTop = chatVirtualListScrollTop(scrollContainer, virtualListRef.current)
      scrollContainer.scrollTo({
        top: virtualRowScrollTop(virtualCells.offsets, groupIndex, listTop)
      })
    },
    [renderGroups, scrollContainer, virtualCells.offsets]
  )

  useEffect(() => {
    if (!focusRequest || !scrollContainer) return undefined
    const selector = `[data-agent-card-id="${CSS.escape(focusRequest.itemId)}"]`
    let frame = 0
    let attempts = 0
    let recenterTimer: number | undefined
    let lastTop: number | null = null

    const center = (target: HTMLElement): void => {
      const container = scrollContainer.getBoundingClientRect()
      const rect = target.getBoundingClientRect()
      lastTop = centeredScrollTop({
        scrollTop: scrollContainer.scrollTop,
        containerTop: container.top,
        containerHeight: container.height,
        elementTop: rect.top,
        elementHeight: rect.height
      })
      scrollContainer.scrollTo({ top: lastTop })
    }
    const settle = (): void => {
      const target = scrollContainer.querySelector<HTMLElement>(selector)
      if (!target) {
        if (attempts < AGENT_LOCATE_MAX_FRAMES) {
          attempts += 1
          frame = window.requestAnimationFrame(settle)
        }
        return
      }
      center(target)
      flashElement(target, primaryColor)
      recenterTimer = window.setTimeout(() => {
        // Not if the user has taken over the scrolling in the meantime.
        if (!target.isConnected || lastTop === null) return
        if (Math.abs(scrollContainer.scrollTop - lastTop) > 4) return
        center(target)
      }, AGENT_LOCATE_RECENTER_MS)
    }

    frame = window.requestAnimationFrame(settle)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(recenterTimer)
    }
  }, [focusRequest, primaryColor, scrollContainer])

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
          <ChatProcessingGroup
            items={group.items}
            focusRequest={focusRequest}
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
      if (group.item.role === 'agent_execution') {
        return (
          <AgentExecutionCard
            item={group.item}
            cwd={cwd}
            onOpenLocalPath={onOpenLocalPath}
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
          userMessageState={
            group.item.role === 'user' ? userMessageStates.get(group.item.id) : undefined
          }
          onEditUserMessage={onEditUserMessage}
          onRetryUserMessage={onRetryUserMessage}
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
      focusRequest,
      isGenerating,
      onEditUserMessage,
      onGoSettings,
      onJumpToNotebookCell,
      onMessagesContentResize,
      onOpenLocalPath,
      onRetryUserMessage,
      renderGroups.length,
      userMessageStates
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
      <AgentRunsOverview runs={runningAgents} onLocate={locateAgentCard} />
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
