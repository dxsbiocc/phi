import { homeCopy } from '../lib/homeCopy'
import { useUiLanguage } from '../../../lib/i18n'
import { Children, useEffect, useState, type ReactNode } from 'react'
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
  '& > *': { flex: 1, minHeight: 0, height: '100%' }
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

export function HomeCarousel({
  labels,
  children
}: {
  labels: string[]
  children: ReactNode
}): React.JSX.Element {
  useUiLanguage()
  const slides = Children.toArray(children)
  const count = slides.length
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const active = count === 0 ? 0 : index % count

  useEffect(() => {
    if (paused || count < 2 || typeof window.matchMedia !== 'function') return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const timer = window.setInterval(() => {
      setIndex((current) => (current + 1) % count)
    }, SLIDE_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [count, paused])

  const show = (next: number): void => {
    if (count === 0) return
    setIndex((next + count) % count)
  }

  return (
    <HomeCarouselFrame
      labels={labels}
      active={active}
      slides={slides}
      onShow={show}
      paused={setPaused}
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
  slides,
  onShow,
  paused
}: {
  labels: string[]
  active: number
  slides: ReactNode[]
  onShow: (next: number) => void
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
          onClick={() => onShow(active - 1)}
        />
        <Box sx={{ display: 'grid', alignItems: 'stretch' }}>
          {slides.map((slide, slideIndex) => (
            <Box
              key={labels[slideIndex] ?? slideIndex}
              aria-hidden={slideIndex !== active}
              inert={slideIndex === active ? undefined : true}
              sx={{
                ...slideSx,
                visibility: slideIndex === active ? 'visible' : 'hidden'
              }}
            >
              {slide}
            </Box>
          ))}
        </Box>
        <CarouselSideButton
          side="right"
          label={homeCopy.nextCard}
          onClick={() => onShow(active + 1)}
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
            onClick={() => onShow(slideIndex)}
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
