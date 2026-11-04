import { Box, type BoxProps, type SxProps, type Theme } from '@mui/material'
import { useEffect, useLayoutEffect, useRef } from 'react'

const overlayScrollContentSx = {
  minWidth: 0,
  minHeight: 0,
  flex: 1,
  overflowX: 'hidden',
  overflowY: 'auto',
  overflowAnchor: 'none',
  scrollbarWidth: 'none',
  msOverflowStyle: 'none',
  '&::-webkit-scrollbar': { display: 'none', width: 0, height: 0 }
}

const rootSx = {
  position: 'relative',
  minWidth: 0,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column'
}

const overlayThumbSx = {
  position: 'absolute',
  top: 0,
  right: 3,
  width: 6,
  borderRadius: 999,
  bgcolor: 'rgba(145, 158, 171, 0.45)',
  pointerEvents: 'none',
  opacity: 0,
  transition: 'opacity 200ms linear'
}

function placeOverlayThumb(scroller: HTMLElement, thumb: HTMLElement, reveal: boolean): void {
  const overflow = scroller.scrollHeight - scroller.clientHeight
  if (overflow <= 1) {
    thumb.style.opacity = '0'
    return
  }
  const height = Math.max(
    28,
    (scroller.clientHeight / scroller.scrollHeight) * scroller.clientHeight
  )
  const top = (scroller.scrollTop / overflow) * (scroller.clientHeight - height)
  thumb.style.height = `${height}px`
  thumb.style.transform = `translateY(${top}px)`
  if (reveal) thumb.style.opacity = '1'
}

function revealOverlayThumb(
  scroller: HTMLElement,
  thumb: HTMLElement,
  fadeTimer: { current: number }
): void {
  placeOverlayThumb(scroller, thumb, true)
  window.clearTimeout(fadeTimer.current)
  fadeTimer.current = window.setTimeout(() => {
    if (thumb.isConnected) thumb.style.opacity = '0'
  }, 700)
}

function joinedSx(base: SxProps<Theme>, extra?: SxProps<Theme>): SxProps<Theme> {
  return extra ? ([base, extra] as SxProps<Theme>) : base
}

export function OverlayScroll({
  children,
  scrollKey = 0,
  contentSx,
  sx,
  ...rest
}: {
  children: React.ReactNode
  scrollKey?: number
  contentSx?: SxProps<Theme>
} & Omit<BoxProps, 'children'>): React.JSX.Element {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const thumbRef = useRef<HTMLDivElement>(null)
  const fadeTimer = useRef(0)

  const syncThumb = (): void => {
    const scroller = scrollerRef.current
    const thumb = thumbRef.current
    if (scroller && thumb) revealOverlayThumb(scroller, thumb, fadeTimer)
  }

  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    const thumb = thumbRef.current
    if (scroller) scroller.scrollTop = 0
    if (scroller && thumb) placeOverlayThumb(scroller, thumb, false)
  }, [scrollKey])

  useEffect(() => {
    const timers = fadeTimer
    return () => window.clearTimeout(timers.current)
  }, [])

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const thumb = thumbRef.current
      if (thumb) placeOverlayThumb(scroller, thumb, false)
    })
    observer.observe(scroller)
    const content = scroller.firstElementChild
    if (content) observer.observe(content)
    return () => observer.disconnect()
  }, [scrollKey])

  return (
    <Box {...rest} sx={joinedSx(rootSx, sx)}>
      <Box ref={scrollerRef} onScroll={syncThumb} sx={joinedSx(overlayScrollContentSx, contentSx)}>
        {children}
      </Box>
      <Box ref={thumbRef} aria-hidden sx={overlayThumbSx} />
    </Box>
  )
}
