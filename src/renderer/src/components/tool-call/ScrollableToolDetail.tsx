import { Box } from '@mui/material'
import { useEffect, useRef, type ReactNode } from 'react'
import { isScrolledToEnd } from '../../lib/agentStepPresentation'

/**
 * Keeps a tool call's arguments and output to a fixed height and lets them scroll, instead of
 * letting them push everything below them down the page. While `follow` is set (the call is
 * still running) the view stays on the newest output, until the user scrolls up to read.
 */
export function ScrollableToolDetail({
  maxHeight,
  follow,
  contentKey,
  children
}: {
  maxHeight: number
  follow: boolean
  /** Changes whenever the content grows, so a followed view can move to its end. */
  contentKey: string
  children: ReactNode
}): ReactNode {
  const viewRef = useRef<HTMLDivElement | null>(null)
  const followingRef = useRef(true)

  useEffect(() => {
    const view = viewRef.current
    if (!view || !follow || !followingRef.current) return
    view.scrollTop = view.scrollHeight
  }, [follow, contentKey])

  return (
    <Box
      ref={viewRef}
      // A scrolling region must be reachable from the keyboard, or its content is not.
      tabIndex={0}
      role="region"
      aria-label="工具调用详情"
      onScroll={() => {
        if (viewRef.current) followingRef.current = isScrolledToEnd(viewRef.current)
      }}
      sx={{
        maxHeight,
        overflowY: 'auto',
        overflowX: 'hidden',
        minWidth: 0,
        '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 }
      }}
    >
      {children}
    </Box>
  )
}
