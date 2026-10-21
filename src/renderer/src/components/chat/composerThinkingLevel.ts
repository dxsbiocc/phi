import { chatCopy } from '../../features/chat/lib/chatCopy'
import type { ThinkingLevel } from '../../types'

const THINKING_LEVEL_ORDER: ThinkingLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  get minimal() {
    return chatCopy.thinkingMinimal
  },
  get low() {
    return chatCopy.thinkingLow
  },
  get medium() {
    return chatCopy.thinkingMedium
  },
  get high() {
    return chatCopy.thinkingHigh
  },
  get xhigh() {
    return chatCopy.thinkingXhigh
  },
  get max() {
    return chatCopy.thinkingMax
  }
}

export interface ThinkingLevelAccent {
  from: string
  to: string
  glow: string
}

const THINKING_LEVEL_ACCENTS: Record<ThinkingLevel, ThinkingLevelAccent> = {
  minimal: { from: '#cbd5e1', to: '#64748b', glow: 'rgba(100, 116, 139, 0.4)' },
  low: { from: '#7dd3fc', to: '#0284c7', glow: 'rgba(2, 132, 199, 0.45)' },
  medium: { from: '#5eead4', to: '#0f766e', glow: 'rgba(15, 118, 110, 0.45)' },
  high: { from: '#6ee7b7', to: '#059669', glow: 'rgba(5, 150, 105, 0.5)' },
  xhigh: { from: '#a5b4fc', to: '#4f46e5', glow: 'rgba(79, 70, 229, 0.5)' },
  max: { from: '#3f5efb', to: '#fc466b', glow: 'rgba(252, 70, 107, 0.45)' }
}

export function thinkingLevelAccent(level: ThinkingLevel | null): ThinkingLevelAccent {
  return level ? THINKING_LEVEL_ACCENTS[level] : THINKING_LEVEL_ACCENTS.minimal
}

export function resolveThinkingSelection(
  thinkingLevel: ThinkingLevel,
  supportedLevels: ThinkingLevel[] | null
): {
  modelDisabled: boolean
  minIndex: number
  maxIndex: number
  currentIndex: number
  label: string
  level: ThinkingLevel | null
} {
  // supportedLevels is null when no model is explicitly selected (unknown until
  // the SDK resolves a default) — in that case don't constrain the slider.
  const modelDisabled = supportedLevels !== null && supportedLevels.length === 0
  const minIndex = supportedLevels?.length ? THINKING_LEVEL_ORDER.indexOf(supportedLevels[0]) : 0
  const maxIndex = supportedLevels?.length
    ? THINKING_LEVEL_ORDER.indexOf(supportedLevels[supportedLevels.length - 1])
    : THINKING_LEVEL_ORDER.length - 1
  const currentIndex = Math.min(
    Math.max(THINKING_LEVEL_ORDER.indexOf(thinkingLevel), minIndex),
    maxIndex
  )
  const level = modelDisabled ? null : THINKING_LEVEL_ORDER[currentIndex]
  return {
    modelDisabled,
    minIndex,
    maxIndex,
    currentIndex,
    level,
    label: modelDisabled ? chatCopy.thinkingOff : THINKING_LEVEL_LABELS[level ?? 'minimal']
  }
}

export function thinkingSliderMarks(minIndex: number, maxIndex: number): Array<{ value: number }> {
  return THINKING_LEVEL_ORDER.flatMap((_level, index) =>
    index >= minIndex && index <= maxIndex ? [{ value: index }] : []
  )
}

export function thinkingLevelAt(index: number): ThinkingLevel {
  return THINKING_LEVEL_ORDER[index]
}

export function createThinkingLevelCommitter(
  currentLevel: () => ThinkingLevel,
  onSelect: (level: ThinkingLevel) => void | Promise<void>
): (level: ThinkingLevel) => void {
  let inflight: Promise<void> | null = null
  let queued: ThinkingLevel | null = null

  const pump = (): void => {
    const level = queued
    queued = null
    if (!level || level === currentLevel()) {
      inflight = null
      return
    }
    const task = Promise.resolve(onSelect(level)).finally(() => {
      if (inflight !== task) return
      inflight = null
      if (queued) pump()
    })
    inflight = task
  }

  return (level: ThinkingLevel): void => {
    if (!inflight && level === currentLevel()) return
    queued = level
    if (inflight) return
    pump()
  }
}
