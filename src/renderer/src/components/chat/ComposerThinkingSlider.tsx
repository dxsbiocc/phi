import { chatCopy } from '../../features/chat/lib/chatCopy'
import { useUiLanguage } from '../../lib/i18n'
import { Box, Slider, Typography, type SxProps, type Theme } from '@mui/material'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { PhiIcons } from '../../icons'
import type { ThinkingLevel } from '../../types'
import {
  createThinkingLevelCommitter,
  resolveThinkingSelection,
  thinkingLevelAccent,
  thinkingLevelAt,
  thinkingSliderMarks,
  type ThinkingLevelAccent
} from './composerThinkingLevel'

const BoltIcon = PhiIcons.action.quick
const THINKING_LEVEL_DEBOUNCE_MS = 300

function usePreviewThinkingLevel(
  thinkingLevel: ThinkingLevel,
  onSelectThinkingLevel: (level: ThinkingLevel) => void | Promise<void>
): {
  displayedLevel: ThinkingLevel
  preview: (index: number) => void
  commit: (index: number) => void
} {
  const [previewLevel, setPreviewLevel] = useState<ThinkingLevel | null>(null)
  const levelRef = useRef(thinkingLevel)
  const onSelectRef = useRef(onSelectThinkingLevel)
  const pendingRef = useRef<{
    timer: ReturnType<typeof setTimeout> | null
    pending: ThinkingLevel | null
  }>({ timer: null, pending: null })
  const publishRef = useRef<((level: ThinkingLevel) => void) | null>(null)
  const publishLevelRef = useRef<(level: ThinkingLevel) => void>(() => undefined)
  if (previewLevel !== null && previewLevel === thinkingLevel) setPreviewLevel(null)

  const clearTimer = (): void => {
    if (!pendingRef.current.timer) return
    clearTimeout(pendingRef.current.timer)
    pendingRef.current.timer = null
  }

  useEffect(() => {
    levelRef.current = thinkingLevel
    onSelectRef.current = onSelectThinkingLevel
    publishLevelRef.current = (level: ThinkingLevel): void => {
      publishRef.current ??= createThinkingLevelCommitter(
        () => levelRef.current,
        (next) => onSelectRef.current(next)
      )
      publishRef.current(level)
    }
  }, [onSelectThinkingLevel, thinkingLevel])
  useEffect(() => {
    const pending = pendingRef.current
    return () => {
      if (pending.timer) clearTimeout(pending.timer)
      const level = pending.pending
      pending.timer = null
      pending.pending = null
      if (level) publishLevelRef.current(level)
    }
  }, [])

  return {
    displayedLevel:
      previewLevel !== null && previewLevel !== thinkingLevel ? previewLevel : thinkingLevel,
    preview(index: number): void {
      setPreviewLevel(thinkingLevelAt(index))
      clearTimer()
      pendingRef.current.pending = null
    },
    commit(index: number): void {
      const level = thinkingLevelAt(index)
      setPreviewLevel(level)
      pendingRef.current.pending = level
      clearTimer()
      pendingRef.current.timer = setTimeout(() => {
        pendingRef.current.timer = null
        pendingRef.current.pending = null
        publishLevelRef.current(level)
      }, THINKING_LEVEL_DEBOUNCE_MS)
    }
  }
}

const THINKING_THUMB_SIZE = 26
const THINKING_TRACK_HEIGHT = 22
const THINKING_TRACK_INSET = THINKING_THUMB_SIZE / 2

function thinkingTrackSx(): SxProps<Theme> {
  return {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    height: THINKING_TRACK_HEIGHT,
    px: `${THINKING_TRACK_INSET}px`,
    overflow: 'visible'
  }
}

function thinkingGrooveSx(): SxProps<Theme> {
  return {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    borderRadius: 999,
    overflow: 'hidden',
    pointerEvents: 'none',
    backgroundColor: 'transparent',
    backgroundImage: (theme: Theme) =>
      theme.palette.mode === 'dark'
        ? 'linear-gradient(to bottom, #334155, #1e293b)'
        : 'linear-gradient(to bottom, #e2e8f0, #94a3b8)',
    boxShadow: 'inset 0 1px 2px rgba(0, 0, 0, 0.28), inset 0 -1px 1px rgba(255, 255, 255, 0.14)'
  }
}

function thinkingFillSx(
  accent: ThinkingLevelAccent,
  disabled: boolean,
  ratio: number
): SxProps<Theme> {
  const from = disabled ? '#94a3b8' : accent.from
  const to = disabled ? '#64748b' : accent.to
  const travel = `100% - ${THINKING_TRACK_INSET * 2}px`
  return {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: ratio >= 1 ? '100%' : `calc(${THINKING_TRACK_INSET}px + ${ratio} * (${travel}))`,
    maxWidth: '100%',
    backgroundImage: `linear-gradient(90deg, ${from}, ${to})`,
    transition: 'background-image 0.35s ease'
  }
}

function thinkingSliderSx(accent: ThinkingLevelAccent, disabled: boolean): SxProps<Theme> {
  const from = disabled ? '#94a3b8' : accent.from
  const to = disabled ? '#64748b' : accent.to
  const glow = disabled ? 'rgba(100, 116, 139, 0.28)' : accent.glow
  const thumbShadow =
    'inset 2px 2px 3px rgba(255, 255, 255, 0.5), inset -2px -2px 3px rgba(0, 0, 0, 0.25)'
  return {
    position: 'relative',
    zIndex: 1,
    width: '100%',
    height: THINKING_THUMB_SIZE,
    p: 0,
    '& .MuiSlider-rail, & .MuiSlider-track': { display: 'none' },
    '& .MuiSlider-thumb': {
      width: THINKING_THUMB_SIZE,
      height: THINKING_THUMB_SIZE,
      backgroundColor: 'transparent',
      backgroundImage: `linear-gradient(145deg, ${from}, ${to})`,
      boxShadow: thumbShadow,
      transition: 'transform 0.18s ease, box-shadow 0.18s ease, background-image 0.35s ease',
      '&::before': { display: 'none' },
      '&:hover, &.Mui-focusVisible': {
        transform: 'translate(-50%, -50%) scale(1.16)',
        boxShadow: `${thumbShadow}, 0 4px 12px ${glow}`
      },
      '&.Mui-active': {
        transform: 'translate(-50%, -50%) scale(1.2)',
        boxShadow: `${thumbShadow}, 0 6px 14px ${glow}`
      }
    },
    '& .MuiSlider-mark': {
      width: 4,
      height: 4,
      borderRadius: '50%',
      backgroundColor: (theme: Theme) =>
        theme.palette.mode === 'dark' ? 'rgba(255, 255, 255, 0.55)' : 'rgba(15, 23, 42, 0.35)',
      opacity: 1
    },
    '& .MuiSlider-markActive': {
      backgroundColor: 'rgba(255, 255, 255, 0.92)',
      opacity: 1
    }
  }
}

export function ThinkingLevelSlider({
  thinkingLevel,
  supportedLevels,
  disabled = false,
  onSelectThinkingLevel
}: {
  thinkingLevel: ThinkingLevel
  supportedLevels: ThinkingLevel[] | null
  disabled?: boolean
  onSelectThinkingLevel: (level: ThinkingLevel) => void | Promise<void>
}): ReactNode {
  useUiLanguage()
  const { displayedLevel, preview, commit } = usePreviewThinkingLevel(
    thinkingLevel,
    onSelectThinkingLevel
  )
  const selection = resolveThinkingSelection(displayedLevel, supportedLevels)
  const sliderDisabled = disabled || selection.modelDisabled
  const accent = thinkingLevelAccent(sliderDisabled ? null : selection.level)
  const span = selection.maxIndex - selection.minIndex
  const fillRatio = span <= 0 ? 1 : (selection.currentIndex - selection.minIndex) / span
  const chooseLevel = (index: number): void => {
    if (!sliderDisabled) preview(index)
  }

  return (
    <Box data-phi-thinking-slider="true" sx={{ px: 1, pt: 0.75, pb: 1, flexShrink: 0 }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 0.5,
          mb: 0.75,
          color: sliderDisabled ? 'text.disabled' : accent.to
        }}
      >
        <BoltIcon size={14} />
        <Typography sx={{ fontWeight: 700, fontSize: '0.85rem', lineHeight: 1.2 }}>
          {selection.label}
        </Typography>
      </Box>
      <Box data-phi-thinking-track="true" sx={thinkingTrackSx()}>
        <Box aria-hidden sx={thinkingGrooveSx()}>
          <Box sx={thinkingFillSx(accent, sliderDisabled, fillRatio)} />
        </Box>
        <Slider
          value={selection.currentIndex}
          min={selection.minIndex}
          max={selection.maxIndex}
          step={1}
          marks={thinkingSliderMarks(selection.minIndex, selection.maxIndex)}
          sx={thinkingSliderSx(accent, sliderDisabled)}
          onChange={(_, value) => {
            chooseLevel(Array.isArray(value) ? value[0] : value)
          }}
          onChangeCommitted={(_, value) => {
            if (!sliderDisabled) commit(Array.isArray(value) ? value[0] : value)
          }}
          disabled={sliderDisabled}
          aria-label={chatCopy.chooseThinkingLevelValue(selection.label)}
        />
      </Box>
    </Box>
  )
}
