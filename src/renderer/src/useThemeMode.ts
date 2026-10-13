import { useEffect, useState } from 'react'
import type { EffectiveMode, ThemeMode } from './theme'
import { isThemePaletteId, type ThemePaletteId } from './themePalettes'

const STORAGE_KEY = 'phi-theme-mode'
const PALETTE_STORAGE_KEY = 'phi-theme-palette'
const LEGACY_FAMILY_STORAGE_KEY = 'phi-theme-family'

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

export function normalizeStoredThemePalette(value: unknown): ThemePaletteId {
  return isThemePaletteId(value) ? value : 'minimal'
}

function readStoredPalette(): ThemePaletteId {
  try {
    const stored = localStorage.getItem(PALETTE_STORAGE_KEY)
    if (isThemePaletteId(stored)) return stored
    // Both legacy families now use Minimal as their common design-system base.
    const legacy = localStorage.getItem(LEGACY_FAMILY_STORAGE_KEY)
    if (legacy === 'default' || legacy === 'minimal') return 'minimal'
  } catch {
    // ignore — fall through to default
  }
  return 'minimal'
}

function readSystemPrefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true
}

export function useThemeMode(): {
  mode: ThemeMode
  effectiveMode: EffectiveMode
  setMode: (mode: ThemeMode) => void
  palette: ThemePaletteId
  setPalette: (palette: ThemePaletteId) => void
} {
  const [mode, setModeState] = useState<ThemeMode>(readStoredMode)
  const [palette, setPaletteState] = useState<ThemePaletteId>(readStoredPalette)
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

  const setPalette = (next: ThemePaletteId): void => {
    setPaletteState(next)
    try {
      localStorage.setItem(PALETTE_STORAGE_KEY, next)
    } catch {
      // ignore persistence failures — the choice still applies for this session
    }
  }

  const effectiveMode: EffectiveMode =
    mode === 'system' ? (systemPrefersDark ? 'dark' : 'light') : mode

  return { mode, effectiveMode, setMode, palette, setPalette }
}
