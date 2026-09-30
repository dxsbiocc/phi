import { useEffect, useState } from 'react'
import type { EffectiveMode, ThemeMode } from './theme'

const STORAGE_KEY = 'phi-theme-mode'
const FAMILY_STORAGE_KEY = 'phi-theme-family'

// Theme families: the original accent-palette theme vs. the Minimal-style theme
// (see docs/design/minimal-style-reference/README.md).
export type ThemeFamily = 'default' | 'minimal'

function readStoredMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      return stored
    }
  } catch {
    // localStorage unavailable (e.g. private mode) — fall through to default
  }
  return 'system'
}

function readStoredFamily(): ThemeFamily {
  try {
    const stored = localStorage.getItem(FAMILY_STORAGE_KEY)
    if (stored === 'default' || stored === 'minimal') {
      return stored
    }
  } catch {
    // ignore — fall through to default
  }
  // Preview the Minimal theme until the user picks a family in Settings.
  return 'minimal'
}

function readSystemPrefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true
}

export function useThemeMode(): {
  mode: ThemeMode
  effectiveMode: EffectiveMode
  setMode: (mode: ThemeMode) => void
  family: ThemeFamily
  setFamily: (family: ThemeFamily) => void
} {
  const [mode, setModeState] = useState<ThemeMode>(readStoredMode)
  const [family, setFamilyState] = useState<ThemeFamily>(readStoredFamily)
  const [systemPrefersDark, setSystemPrefersDark] = useState(readSystemPrefersDark)

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const handleChange = (event: MediaQueryListEvent): void => setSystemPrefersDark(event.matches)
    media.addEventListener('change', handleChange)
    return () => media.removeEventListener('change', handleChange)
  }, [])

  const setMode = (next: ThemeMode): void => {
    setModeState(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // ignore persistence failures — the choice still applies for this session
    }
  }

  const setFamily = (next: ThemeFamily): void => {
    setFamilyState(next)
    try {
      localStorage.setItem(FAMILY_STORAGE_KEY, next)
    } catch {
      // ignore persistence failures — the choice still applies for this session
    }
  }

  const effectiveMode: EffectiveMode =
    mode === 'system' ? (systemPrefersDark ? 'dark' : 'light') : mode

  return { mode, effectiveMode, setMode, family, setFamily }
}
