import { homeCopy } from '../lib/homeCopy'
import {
  carouselSlideMotion,
  HOME_CAROUSEL_SLIDE_MS,
  type SlideDirection
} from '../lib/homeCarouselMotion'
import { useUiLanguage } from '../../../lib/i18n'
import { Children, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Box, IconButton } from '@mui/material'
import { PhiIcons } from '../../../icons'

const SLIDE_INTERVAL_MS = 7000

const slideSx = {
  gridColumn: 1,
  gridRow: 1,
  width: '100%',
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  '& > *': { flex: 1, minHeight: 0, height: '100%' },
  '@media (prefers-reduced-motion: reduce)': { transition: 'none' }
} as const

const dotsSx = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 1,
  mt: 1.5
} as const

const dotSx = {
  height: 8,
  p: 0,
  border: 0,
  borderRadius: 999,
  cursor: 'pointer',
  transition: 'width 200ms ease, background-color 200ms ease'
} as const

function normalizeIndex(index: number, count: number): number {
  return ((index % count) + count) % count
}

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

function useHomeCarousel(count: number): {
  active: number
  incoming: number | null
  direction: SlideDirection
  animate: boolean
  setPaused: (value: boolean) => void
  show: (next: number, direction?: SlideDirection) => void
} {
  const [active, setActive] = useState(0)
  const [incoming, setIncoming] = useState<number | null>(null)
  const [direction, setDirection] = useState<SlideDirection>(1)
  const [animate, setAnimate] = useState(false)
  const [paused, setPaused] = useState(false)
  const lockedRef = useRef(false)

  useEffect(() => {
    if (incoming === null) return
    let cancelled = false
    const frame = window.requestAnimationFrame(() => {
      if (cancelled) return
      lockedRef.current = true
      setActive(incoming)
      setIncoming(null)
      setAnimate(true)
    })
    return () => {
      cancelled = true
      window.cancelAnimationFrame(frame)
    }
  }, [incoming])

  useEffect(() => {
    if (!animate) return
    const timer = window.setTimeout(() => {
      lockedRef.current = false
    }, HOME_CAROUSEL_SLIDE_MS)
    return () => window.clearTimeout(timer)
  }, [animate, active])

  const show = useCallback(
    (next: number, nextDirection: SlideDirection = 1): void => {
      if (count < 2) return
      const normalized = normalizeIndex(next, count)
      if (normalized === active || incoming !== null || lockedRef.current) return
      if (prefersReducedMotion()) {
        setActive(normalized)
        setAnimate(false)
        return
      }
      setDirection(nextDirection)
      setAnimate(false)
      setIncoming(normalized)
    },
    [active, count, incoming]
  )

  useEffect(() => {
    if (paused || count < 2 || prefersReducedMotion()) return
    const timer = window.setInterval(() => show(active + 1, 1), SLIDE_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [active, count, paused, show])

  return {
    active: count === 0 ? 0 : normalizeIndex(active, count),
    incoming,
    direction,
    animate,
    setPaused,
    show
  }
}

export function HomeCarousel({
  labels,
  children
}: {
  labels: string[]
  children: ReactNode
}): React.JSX.Element {
  useUiLanguage()
  const slides = Children.toArray(children)
  const motion = useHomeCarousel(slides.length)

  return (
    <HomeCarouselFrame
      labels={labels}
      active={motion.active}
      incoming={motion.incoming}
      direction={motion.direction}
      animate={motion.animate}
      slides={slides}
      onShow={motion.show}
      paused={motion.setPaused}
    />
  )
}

function CarouselSideButton({
  label,
  side,
  flip,
  onClick
}: {
  label: string
  side: 'left' | 'right'
  flip?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <IconButton
      size="small"
      aria-label={label}
      onClick={onClick}
      sx={{
        position: 'absolute',
        top: '50%',
        left: side === 'left' ? -44 : undefined,
        right: side === 'right' ? -44 : undefined,
        transform: 'translateY(-50%)',
        zIndex: 1,
        width: 36,
        height: 36,
        bgcolor: 'background.paper',
        border: 1,
        borderColor: 'divider',
        '&:hover': { bgcolor: 'action.hover' }
      }}
    >
      <Box
        component="span"
        sx={{ display: 'inline-flex', transform: flip ? 'rotate(180deg)' : undefined }}
      >
        <PhiIcons.action.back size={18} />
      </Box>
    </IconButton>
  )
}

function HomeCarouselFrame({
  labels,
  active,
  incoming,
  direction,
  animate,
  slides,
  onShow,
  paused
}: {
  labels: string[]
  active: number
  incoming: number | null
  direction: SlideDirection
  animate: boolean
  slides: ReactNode[]
  onShow: (next: number, direction?: SlideDirection) => void
  paused: (value: boolean) => void
}): React.JSX.Element {
  return (
    <Box
      data-phi-home-carousel="true"
      role="region"
      aria-roledescription={homeCopy.carousel}
      sx={{ width: '100%' }}
      onMouseEnter={() => paused(true)}
      onMouseLeave={() => paused(false)}
      onFocus={() => paused(true)}
      onBlur={() => paused(false)}
    >
      <Box sx={{ position: 'relative', width: '100%' }}>
        <CarouselSideButton
          side="left"
          flip
          label={homeCopy.previousCard}
          onClick={() => onShow(active - 1, -1)}
        />
        <Box sx={{ display: 'grid', alignItems: 'stretch', overflow: 'hidden', borderRadius: 3 }}>
          {slides.map((slide, slideIndex) => (
            <Box
              key={labels[slideIndex] ?? slideIndex}
              aria-hidden={slideIndex !== active}
              inert={slideIndex === active ? undefined : true}
              sx={{
                ...slideSx,
                ...carouselSlideMotion(slideIndex, active, incoming, direction, animate),
                zIndex: slideIndex === active ? 1 : 0,
                pointerEvents: slideIndex === active ? 'auto' : 'none'
              }}
            >
              {slide}
            </Box>
          ))}
        </Box>
        <CarouselSideButton
          side="right"
          label={homeCopy.nextCard}
          onClick={() => onShow(active + 1, 1)}
        />
      </Box>
      <Box sx={dotsSx}>
        {labels.map((label, slideIndex) => (
          <Box
            key={label}
            component="button"
            type="button"
            aria-label={label}
            aria-current={slideIndex === active ? 'true' : undefined}
            onClick={() => onShow(slideIndex, slideIndex >= active ? 1 : -1)}
            sx={{
              ...dotSx,
              width: slideIndex === active ? 22 : 8,
              bgcolor: slideIndex === active ? 'primary.main' : 'action.disabled'
            }}
          />
        ))}
      </Box>
    </Box>
  )
}
