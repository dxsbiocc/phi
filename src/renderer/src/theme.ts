import { createTheme, darken, lighten, type Theme } from '@mui/material'

import { createMinimalTheme, type SemanticScale } from './minimalTheme'

export type ThemeMode = 'light' | 'dark' | 'system'
export type EffectiveMode = 'light' | 'dark'

// The 8-color accent set the app is themed around. Index 0 (navy) anchors dark-mode
// chrome; 1-7 are the vivid accents cycled across settings categories, chips, etc.
export const ACCENT_PALETTE = [
  '#0E3A45', // navy
  '#F2994A', // orange
  '#E8604C', // coral red
  '#2E9FB3', // teal blue (primary)
  '#E0356F', // magenta / pink
  '#3ABAA4', // turquoise
  '#7B9A1F', // olive green
  '#EFC94C' // mustard yellow
] as const

// Skips the navy anchor — used to color category icons, avatars, tags, etc. Cycles
// with `accentAt(index)` once there are more items than colors.
const CATEGORY_ACCENTS = ACCENT_PALETTE.slice(1)

export function accentAt(index: number): string {
  return CATEGORY_ACCENTS[index % CATEGORY_ACCENTS.length]
}

const PRIMARY = ACCENT_PALETTE[3]
const NAVY = ACCENT_PALETTE[0]
const SUCCESS = ACCENT_PALETTE[5]
const ERROR = ACCENT_PALETTE[2]
const WARNING = ACCENT_PALETTE[7]

// Derives the five-shade scale the shared component styles expect (lighter tint
// backgrounds through darker text shades) from a single accent color.
function accentScale(main: string): SemanticScale {
  return {
    lighter: lighten(main, 0.85),
    light: lighten(main, 0.35),
    main,
    dark: darken(main, 0.2),
    darker: darken(main, 0.45)
  }
}

// The default family is a color-only variant: Minimal provides the typography,
// shadows, shape, and component styles; this family swaps in the accent palette,
// teal-tinted neutrals, and its dark teal chrome.
export function createAppTheme(mode: EffectiveMode): Theme {
  const isDark = mode === 'dark'
  const base = createMinimalTheme(mode)

  return createTheme(base, {
    palette: {
      primary: { ...accentScale(PRIMARY), contrastText: '#FFFFFF' },
      secondary: {
        ...accentScale(isDark ? '#33515A' : '#D7E4E6'),
        // Explicit because palette overrides merge post-augmentation: the pale
        // light-mode secondary needs dark text, not Minimal's white.
        contrastText: isDark ? '#FFFFFF' : '#0F2A30'
      },
      info: { ...accentScale(isDark ? '#29B6F6' : '#0288D1'), contrastText: '#FFFFFF' },
      success: { ...accentScale(SUCCESS), contrastText: '#FFFFFF' },
      error: { ...accentScale(ERROR), contrastText: '#FFFFFF' },
      warning: { ...accentScale(WARNING), contrastText: '#1A1500' },
      background: {
        default: isDark ? '#0B262D' : '#FFFFFF',
        paper: isDark ? '#123640' : '#FFFFFF'
      },
      text: {
        primary: isDark ? '#F1F6F6' : '#0F2A30',
        secondary: isDark ? '#9FB8BC' : '#4B6469'
      },
      divider: isDark ? 'rgba(241, 246, 246, 0.12)' : 'rgba(15, 42, 48, 0.12)',
      action: {
        hover: isDark ? 'rgba(241, 246, 246, 0.06)' : 'rgba(46, 159, 179, 0.06)',
        selected: isDark ? 'rgba(46, 159, 179, 0.22)' : 'rgba(46, 159, 179, 0.10)'
      }
    }
  })
}

export const NAVY_ACCENT = NAVY
