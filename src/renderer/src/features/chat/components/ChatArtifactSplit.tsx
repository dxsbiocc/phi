import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type Ref
} from 'react'

import {
  CHAT_ARTIFACT_SPLIT_SEPARATOR_PX,
  type ChatArtifactSplitStorage,
  chatArtifactSplitWidths,
  clampChatArtifactSplitRatio,
  keyboardAdjustedChatArtifactSplitRatio,
  readChatArtifactSplitRatio,
  writeChatArtifactSplitRatio
} from '../lib/chatArtifactSplit'

function browserStorage(): ChatArtifactSplitStorage | undefined {
  if (typeof window === 'undefined') return undefined
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

export interface ChatArtifactSplitProps {
  enabled: boolean
  children: ReactNode
  artifact: ReactNode
}

export interface ChatArtifactSplitSurfaceProps {
  children: ReactNode
  artifact: ReactNode
  rootRef?: Ref<HTMLDivElement>
  ratioPercent: number
  widths: { left: number; right: number } | null
  isDragging: boolean
  onStartDrag: (event: ReactMouseEvent<HTMLDivElement>) => void
  onSeparatorKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
}

export function ChatArtifactSplitSurface({
  children,
  artifact,
  rootRef,
  ratioPercent,
  widths,
  isDragging,
  onStartDrag,
  onSeparatorKeyDown
}: ChatArtifactSplitSurfaceProps): React.JSX.Element {
  return (
    <div
      ref={rootRef}
      data-phi-chat-artifact-split="enabled"
      data-phi-chat-artifact-dragging={isDragging ? 'true' : 'false'}
      style={{
        display: 'flex',
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        overflow: 'hidden',
        position: 'relative'
      }}
    >
      <div
        data-phi-chat-artifact-pane="chat"
        style={{
          display: 'flex',
          flex: widths ? `0 0 ${widths.left}px` : `0 1 ${ratioPercent}%`,
          minWidth: 0,
          minHeight: 0,
          overflow: 'hidden'
        }}
      >
        {children}
      </div>
      <div
        role="separator"
        aria-label="调整聊天与预览宽度"
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={ratioPercent}
        tabIndex={0}
        onMouseDown={onStartDrag}
        onKeyDown={onSeparatorKeyDown}
        style={{
          width: CHAT_ARTIFACT_SPLIT_SEPARATOR_PX,
          flexShrink: 0,
          cursor: 'col-resize',
          background: 'var(--mui-palette-divider, rgba(127, 127, 127, 0.24))',
          outlineOffset: -2,
          zIndex: 2
        }}
      />
      <div
        data-phi-chat-artifact-pane="artifact"
        style={{
          display: 'flex',
          flex: widths ? `0 0 ${widths.right}px` : '1 1 auto',
          minWidth: 0,
          minHeight: 0,
          overflow: 'hidden',
          pointerEvents: isDragging ? 'none' : 'auto'
        }}
      >
        {artifact}
      </div>
      <div
        aria-hidden="true"
        data-phi-webview-drag-overlay="true"
        style={{
          display: isDragging ? 'block' : 'none',
          position: 'absolute',
          inset: 0,
          cursor: 'col-resize',
          zIndex: 3
        }}
      />
    </div>
  )
}

export function ChatArtifactSplit({
  enabled,
  children,
  artifact
}: ChatArtifactSplitProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  const [isDragging, setIsDragging] = useState(false)
  const [ratio, setRatio] = useState(() => readChatArtifactSplitRatio(browserStorage()))

  const updateRatioFromClientX = useCallback((clientX: number): void => {
    const root = rootRef.current
    if (!root) return
    const bounds = root.getBoundingClientRect()
    const width = bounds.width
    const availableWidth = Math.max(0, width - CHAT_ARTIFACT_SPLIT_SEPARATOR_PX)
    if (availableWidth === 0) return
    setRatio(clampChatArtifactSplitRatio((clientX - bounds.left) / availableWidth, width))
  }, [])

  useEffect(() => {
    if (!enabled) return
    const root = rootRef.current
    if (!root) return
    const updateWidth = (): void => setContainerWidth(root.getBoundingClientRect().width)
    updateWidth()

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateWidth)
      return () => window.removeEventListener('resize', updateWidth)
    }

    const observer = new ResizeObserver(updateWidth)
    observer.observe(root)
    return () => observer.disconnect()
  }, [enabled])

  useEffect(() => {
    if (!enabled || !isDragging) return
    const onMouseMove = (event: MouseEvent): void => updateRatioFromClientX(event.clientX)
    const stopDragging = (): void => setIsDragging(false)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', stopDragging)
    window.addEventListener('blur', stopDragging)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', stopDragging)
      window.removeEventListener('blur', stopDragging)
    }
  }, [enabled, isDragging, updateRatioFromClientX])

  useEffect(() => {
    if (!enabled) return
    writeChatArtifactSplitRatio(browserStorage(), ratio)
  }, [enabled, ratio])

  if (!enabled) return <>{children}</>

  const effectiveRatio =
    containerWidth > 0 ? clampChatArtifactSplitRatio(ratio, containerWidth) : ratio
  const ratioPercent = Math.round(effectiveRatio * 100)
  const widths = containerWidth > 0 ? chatArtifactSplitWidths(effectiveRatio, containerWidth) : null

  return (
    <ChatArtifactSplitSurface
      rootRef={rootRef}
      ratioPercent={ratioPercent}
      widths={widths}
      isDragging={isDragging}
      artifact={artifact}
      onStartDrag={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        updateRatioFromClientX(event.clientX)
        setIsDragging(true)
      }}
      onSeparatorKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        const width = rootRef.current?.getBoundingClientRect().width ?? containerWidth
        setRatio((current) => keyboardAdjustedChatArtifactSplitRatio(current, event.key, width))
      }}
    >
      {children}
    </ChatArtifactSplitSurface>
  )
}
