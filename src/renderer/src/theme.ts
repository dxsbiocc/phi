import { createTheme, type Theme } from '@mui/material'

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

export function createAppTheme(mode: EffectiveMode): Theme {
  const isDark = mode === 'dark'

  return createTheme({
    palette: {
      mode,
      primary: { main: PRIMARY, contrastText: '#FFFFFF' },
      secondary: { main: isDark ? '#33515A' : '#D7E4E6' },
      success: { main: SUCCESS, contrastText: '#FFFFFF' },
      error: { main: ERROR, contrastText: '#FFFFFF' },
      warning: { main: WARNING, contrastText: '#1A1500' },
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
    },
    typography: {
      fontFamily:
        "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif"
    },
    shape: {
      borderRadius: 8
    },
    // Surfaced on the Theme type by the minimal theme's module augmentation;
    // defined here too so both theme families honor the same contract.
    customShadows: {
      card: isDark
        ? '0 1px 2px rgba(0, 0, 0, 0.32), 0 8px 16px -4px rgba(0, 0, 0, 0.24)'
        : '0 1px 2px rgba(15, 42, 48, 0.08), 0 8px 16px -4px rgba(15, 42, 48, 0.08)',
      dropdown: isDark
        ? '0 2px 4px rgba(0, 0, 0, 0.32), 0 16px 32px -8px rgba(0, 0, 0, 0.4)'
        : '0 2px 4px rgba(15, 42, 48, 0.08), 0 16px 32px -8px rgba(15, 42, 48, 0.16)',
      dialog: isDark
        ? '0 4px 8px rgba(0, 0, 0, 0.32), 0 24px 48px -12px rgba(0, 0, 0, 0.48)'
        : '0 4px 8px rgba(15, 42, 48, 0.08), 0 24px 48px -12px rgba(15, 42, 48, 0.2)',
      listItem: isDark
        ? '0 1px 2px rgba(0, 0, 0, 0.36), 0 4px 8px -2px rgba(0, 0, 0, 0.28)'
        : '0 1px 2px rgba(15, 42, 48, 0.1), 0 4px 8px -2px rgba(15, 42, 48, 0.08)'
    },
    transitions: {
      duration: {
        shortest: 150,
        shorter: 200,
        short: 250,
        standard: 250,
        complex: 300,
        enteringScreen: 250,
        leavingScreen: 200
      }
    },
    components: {
      MuiButton: {
        styleOverrides: {
          root: {
            textTransform: 'none',
            transition: 'all 0.2s ease',
            ':hover': {
              transform: 'translateY(-1px)'
            }
          }
        }
      },
      MuiListItemButton: {
        styleOverrides: {
          root: {
            transition: 'background-color 0.15s ease',
            borderRadius: 6,
            margin: '0 8px 2px'
          }
        }
      },
      MuiIconButton: {
        styleOverrides: {
          root: {
            transition: 'all 0.2s ease'
          }
        }
      }
    }
  })
}

export const NAVY_ACCENT = NAVY
