import { useCallback, useEffect, useRef } from 'react'

const TRANSITION_FRAME_COUNT = 24
const TRANSITION_CHECKPOINTS_MS = [80, 180, 320, 520]

export type ChatContentResizeOptions = {
  preserveScrollPosition?: boolean
}

export type ChatContentResizeHandler = (options?: ChatContentResizeOptions) => void

const USER_COLLAPSE_RESIZE_OPTIONS: ChatContentResizeOptions = {
  preserveScrollPosition: true
}

export function useCollapseResizeNotifier(onContentResize?: ChatContentResizeHandler): () => void {
  const animationFrameRef = useRef<number | null>(null)
  const timeoutRefs = useRef<number[]>([])

  const clearScheduledNotifications = useCallback((): void => {
    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = null
    }
    for (const timeout of timeoutRefs.current) {
      window.clearTimeout(timeout)
    }
    timeoutRefs.current = []
  }, [])

  const notifyDuringTransition = useCallback((): void => {
    if (!onContentResize || typeof window === 'undefined') return

    clearScheduledNotifications()
    onContentResize(USER_COLLAPSE_RESIZE_OPTIONS)

    let frameCount = 0
    const tick = (): void => {
      onContentResize(USER_COLLAPSE_RESIZE_OPTIONS)
      frameCount += 1
      if (frameCount < TRANSITION_FRAME_COUNT) {
        animationFrameRef.current = window.requestAnimationFrame(tick)
      } else {
        animationFrameRef.current = null
      }
    }
    animationFrameRef.current = window.requestAnimationFrame(tick)
    timeoutRefs.current = TRANSITION_CHECKPOINTS_MS.map((delay) =>
      window.setTimeout(() => onContentResize(USER_COLLAPSE_RESIZE_OPTIONS), delay)
    )
  }, [clearScheduledNotifications, onContentResize])

  useEffect(() => clearScheduledNotifications, [clearScheduledNotifications])

  return notifyDuringTransition
}
