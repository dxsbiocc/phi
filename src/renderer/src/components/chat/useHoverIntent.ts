import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Hover that means it. Opens only after the pointer has rested for a moment (so crossing the
 * screen does not flicker things open) and closes only after it has been away for a moment (so
 * the pointer can travel from the trigger to what it opened without losing it). Both the trigger
 * and the opened panel call `onEnter`/`onLeave`; while either is under the pointer it stays open.
 */
export function useHoverIntent(options: { openDelayMs: number; closeDelayMs: number }): {
  hovering: boolean
  onEnter: () => void
  onLeave: () => void
  /** Closes at once, e.g. after the user picked something. */
  reset: () => void
} {
  const { openDelayMs, closeDelayMs } = options
  const [hovering, setHovering] = useState(false)
  const timerRef = useRef<number | undefined>(undefined)

  const clear = useCallback((): void => {
    window.clearTimeout(timerRef.current)
    timerRef.current = undefined
  }, [])

  const onEnter = useCallback((): void => {
    clear()
    timerRef.current = window.setTimeout(() => setHovering(true), openDelayMs)
  }, [clear, openDelayMs])

  const onLeave = useCallback((): void => {
    clear()
    timerRef.current = window.setTimeout(() => setHovering(false), closeDelayMs)
  }, [clear, closeDelayMs])

  const reset = useCallback((): void => {
    clear()
    setHovering(false)
  }, [clear])

  useEffect(() => clear, [clear])

  return { hovering, onEnter, onLeave, reset }
}
