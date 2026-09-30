import { Box, IconButton } from '@mui/material'
import { alpha, useTheme } from '@mui/material/styles'
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { type LocalPathKind } from '../MarkdownContent'
import AgentExecutionCard from '../AgentExecutionCard'
import ToolCallCard from '../ToolCallCard'
import ToolGroupCard from '../ToolGroupCard'
import { WrapperPlanCard } from '../../features/wrapper/components/WrapperPlanCard'
import { WorkspaceChangesCard } from '../../features/chat/components/WorkspaceChangesCard'
import { PresentedFilesCard } from '../../features/chat/components/PresentedFilesCard'
import { PlanReviewCard } from '../../features/chat/components/PlanReviewCard'
import { PhiIcons } from '../../icons'
import {
  centeredScrollTop,
  groupIndexContainingItem,
  runningAgentRuns,
  virtualRowScrollTop
} from '../../lib/agentRunsOverview'
import {
  activeProcessingGroupIndex,
  groupMessages,
  timestampMs,
  type RenderGroup
} from '../../lib/chatRenderGroups'
import { shouldCommitChatRowHeight, shouldFollowLatestContent } from '../../lib/chatScrollFollow'
import {
  chatVirtualMinimumRowCount,
  chatVirtualWindow,
  normalizedChatVirtualRowHeight,
  type ChatVirtualItem,
  type ChatVirtualViewport
} from '../../lib/chatVirtualization'
import { useLostAgentRunsStore } from '../../stores/lostAgentRunsStore'
import { latestTodoSnapshot } from '../../lib/todoPanel'
import type { ChatItem, ChatMessage, NotebookCellJumpTarget } from '../../types'
import AgentRunsOverview from './AgentRunsOverview'
import { ChatBubble } from './ChatBubble'
import { ChatProcessingGroup, type ChatFocusRequest } from './ChatProcessingGroup'
import { type UserMessageRetryTarget, type UserMessageState } from './ChatUserMessage'
import TodoStepPanel from './TodoStepPanel'
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
  scrollPositionStore?: Map<string, number>
  isGenerating: boolean
  currentRunStartedAt?: string
  onEditUserMessage?: (content: string) => void
  onRetryUserMessage?: (message: UserMessageRetryTarget) => void
  onForkUserMessage?: (messageId: string) => void
  onGoSettings: () => void
  onOpenBackgroundJobs: () => void
  onOpenLocalPath?: (path: string, pathKind: LocalPathKind) => void
  onJumpToNotebookCell?: (target: NotebookCellJumpTarget) => void
  cwd?: string
}

const ChatMessageList = memo(function ChatMessageList({
  messages,
  messagesContainerRef,
  scrollResetKey,
  scrollPositionStore,
  isGenerating,
  currentRunStartedAt,
  onEditUserMessage,
  onRetryUserMessage,
  onForkUserMessage,
  onGoSettings,
  onOpenBackgroundJobs,
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
  const hasSavedScrollPosition =
    scrollResetKey !== undefined && scrollPositionStore?.has(scrollResetKey) === true
  const [isStuckToBottom, setIsStuckToBottom] = useState(!hasSavedScrollPosition)
  const stickToBottomRef = useRef(!hasSavedScrollPosition)
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
  const todoSnapshot = useMemo(() => latestTodoSnapshot(messages), [messages])
  const virtualRowObserversRef = useRef<Map<string, ResizeObserver>>(new Map())
  const pendingRowHeightsRef = useRef<Record<string, number>>({})
  const rowHeightFrameRef = useRef<number | null>(null)
  const scrollResetKeyRef = useRef(scrollResetKey)
  scrollResetKeyRef.current = scrollResetKey
  const seenScrollResetKeyRef = useRef(scrollResetKey)
  if (seenScrollResetKeyRef.current !== scrollResetKey) {
    seenScrollResetKeyRef.current = scrollResetKey
    pendingRowHeightsRef.current = {}
    if (rowHeightFrameRef.current !== null) {
      window.cancelAnimationFrame(rowHeightFrameRef.current)
      rowHeightFrameRef.current = null
    }
  }
  const virtualizationEnabledRef = useRef(false)
  const visibleRowKeysRef = useRef<ReadonlySet<string>>(new Set())
  const currentMessageMarker = useMemo(() => messageScrollMarker(messages), [messages])
  const currentMessageMarkerRef = useRef(currentMessageMarker)
  useLayoutEffect(() => {
    currentMessageMarkerRef.current = currentMessageMarker
  }, [currentMessageMarker])
  const renderGroups = useMemo(
    () => groupMessages(messages, { activeRun: isGenerating }),
    [isGenerating, messages]
  )
  const activeProcessingIndex = useMemo(
    () => activeProcessingGroupIndex(renderGroups, isGenerating),
    [isGenerating, renderGroups]
  )
  const userMessageStates = useMemo(() => failedUserMessageStates(messages), [messages])
  const virtualItems = useMemo<ChatGroupVirtualItem[]>(
    () => renderGroups.map((group) => ({ id: group.key, group })),
    [renderGroups]
  )

  const [virtualViewport, setVirtualViewport] = useState<ChatVirtualViewport>({
    scrollTop: scrollResetKey !== undefined ? (scrollPositionStore?.get(scrollResetKey) ?? 0) : 0,
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
  virtualizationEnabledRef.current = virtualItems.length >= chatVirtualMinimumRowCount
  visibleRowKeysRef.current = new Set(virtualCells.items.map(({ item }) => item.id))

  const flushRowHeights = useCallback((): void => {
    rowHeightFrameRef.current = null
    const pending = pendingRowHeightsRef.current
    const pendingKeys = Object.keys(pending)
    if (pendingKeys.length === 0) return
    pendingRowHeightsRef.current = {}
    const resetKey = scrollResetKeyRef.current
    setVirtualRowHeightState((current) => {
      const base = current.resetKey === resetKey ? current.heights : {}
      const changed =
        current.resetKey !== resetKey || pendingKeys.some((key) => base[key] !== pending[key])
      if (!changed) return current
      return { resetKey, heights: { ...base, ...pending } }
    })
  }, [])

  const measureVirtualRow = useCallback(
    (groupKey: string, element: HTMLDivElement | null): void => {
      const existingObserver = virtualRowObserversRef.current.get(groupKey)
      if (existingObserver) {
        existingObserver.disconnect()
        virtualRowObserversRef.current.delete(groupKey)
      }
      if (!element) return

      const queueHeight = (): void => {
        if (!element.isConnected) return
        if (
          !shouldCommitChatRowHeight({
            virtualizationEnabled: virtualizationEnabledRef.current,
            rowInWindow: visibleRowKeysRef.current.has(groupKey)
          })
        ) {
          return
        }
        const height = normalizedChatVirtualRowHeight(element.getBoundingClientRect().height)
        if (pendingRowHeightsRef.current[groupKey] === height) return
        pendingRowHeightsRef.current[groupKey] = height
        if (rowHeightFrameRef.current !== null) return
        rowHeightFrameRef.current = window.requestAnimationFrame(flushRowHeights)
      }

      if (typeof ResizeObserver === 'undefined') {
        queueHeight()
        return
      }
      const observer = new ResizeObserver(queueHeight)
      observer.observe(element)
      virtualRowObserversRef.current.set(groupKey, observer)
      queueHeight()
    },
    [flushRowHeights]
  )

  useEffect(() => {
    const observers = virtualRowObserversRef.current
    return () => {
      for (const observer of observers.values()) observer.disconnect()
      observers.clear()
      if (rowHeightFrameRef.current !== null) {
        window.cancelAnimationFrame(rowHeightFrameRef.current)
        rowHeightFrameRef.current = null
      }
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
      if (scrollResetKey) scrollPositionStore?.delete(scrollResetKey)
    },
    [scrollContainer, scrollPositionStore, scrollResetKey]
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

      // Away from the tail, growing output stays below the fold. The one
      // exception is the reader collapsing or expanding something already in
      // view: keep that row from jumping under their cursor.
      if (!stickToBottomRef.current) {
        if (!options?.preserveScrollPosition) return
        suppressAutoScrollUntilRef.current = Date.now() + USER_RESIZE_AUTO_SCROLL_SUPPRESSION_MS
        updateScrollState(scrollContainer)
        return
      }

      if (Date.now() < suppressAutoScrollUntilRef.current) return
      scrollToLatest()
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
    if (!scrollContainer || !scrollResetKey || !scrollPositionStore) return
    if (stickToBottomRef.current) scrollPositionStore.delete(scrollResetKey)
    else scrollPositionStore.set(scrollResetKey, scrollContainer.scrollTop)
  }, [scrollContainer, scrollPositionStore, scrollResetKey, updateScrollState])

  const handleJumpToLatest = useCallback((): void => {
    scrollToLatest()
  }, [scrollToLatest])

  useLayoutEffect(() => {
    const savedTop = scrollResetKey ? scrollPositionStore?.get(scrollResetKey) : undefined
    const restorePosition = savedTop !== undefined
    lastMessageMarkerRef.current = restorePosition ? currentMessageMarkerRef.current : null
    stickToBottomRef.current = !restorePosition
    suppressAutoScrollUntilRef.current = 0
    if (!scrollContainer) return undefined

    const frame = window.requestAnimationFrame(() => {
      if (restorePosition) {
        scrollContainer.scrollTop = savedTop
        setIsStuckToBottom(false)
        setVirtualViewport({ scrollTop: savedTop, viewportHeight: scrollContainer.clientHeight })
        updateScrollState(scrollContainer)
      } else {
        scrollToLatest()
      }
    })
    return () => {
      window.cancelAnimationFrame(frame)
      if (!scrollResetKey || !scrollPositionStore) return
      if (stickToBottomRef.current) scrollPositionStore.delete(scrollResetKey)
      else scrollPositionStore.set(scrollResetKey, scrollContainer.scrollTop)
    }
  }, [scrollContainer, scrollPositionStore, scrollResetKey, scrollToLatest, updateScrollState])

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

    if (
      !shouldFollowLatestContent({
        stuckToBottom: stickToBottomRef.current,
        replacedMessages,
        userSubmittedMessage
      })
    ) {
      return undefined
    }

    const frame = window.requestAnimationFrame(() => scrollToLatest())
    return () => window.cancelAnimationFrame(frame)
  }, [currentMessageMarker, scrollContainer, scrollToLatest])

  useEffect(() => {
    if (!scrollContainer || typeof ResizeObserver === 'undefined') {
      return undefined
    }

    const content = scrollContainer.firstElementChild
    if (!content) return undefined

    let frame: number | null = null
    const scheduleResize = (): void => {
      if (!stickToBottomRef.current) return
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
        const isActiveProcessingGroup = absoluteIndex === activeProcessingIndex
        return (
          <ChatProcessingGroup
            items={group.items}
            focusRequest={focusRequest}
            onGoSettings={onGoSettings}
            onOpenBackgroundJobs={onOpenBackgroundJobs}
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
      if (group.item.role === 'workspace_changes') {
        return (
          <WorkspaceChangesCard
            item={group.item}
            onOpenFile={onOpenLocalPath ? (path) => onOpenLocalPath(path, 'file') : undefined}
          />
        )
      }
      if (group.item.role === 'presented_files') {
        return (
          <PresentedFilesCard
            item={group.item}
            onOpenFile={onOpenLocalPath ? (path) => onOpenLocalPath(path, 'file') : undefined}
          />
        )
      }
      if (group.item.role === 'plan_review') {
        return <PlanReviewCard item={group.item} cwd={cwd} />
      }
      return (
        <ChatBubble
          message={group.item}
          userMessageState={
            group.item.role === 'user' ? userMessageStates.get(group.item.id) : undefined
          }
          onEditUserMessage={onEditUserMessage}
          onRetryUserMessage={onRetryUserMessage}
          onForkUserMessage={onForkUserMessage}
          onGoSettings={onGoSettings}
          onOpenBackgroundJobs={onOpenBackgroundJobs}
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
      activeProcessingIndex,
      onEditUserMessage,
      onGoSettings,
      onOpenBackgroundJobs,
      onJumpToNotebookCell,
      onMessagesContentResize,
      onOpenLocalPath,
      onRetryUserMessage,
      onForkUserMessage,
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
            pb: isGenerating ? 6 : 3,
            '@container phi-chat (max-width: 560px)': {
              px: 1.25,
              pt: 1.5,
              pb: isGenerating ? 3 : 1.5
            }
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
      <TodoStepPanel snapshot={todoSnapshot} />
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
