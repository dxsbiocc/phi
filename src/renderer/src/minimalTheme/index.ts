import {
  alpha,
  createTheme,
  type PaletteColorOptions,
  type Theme,
  type ThemeOptions
} from '@mui/material'

import { buildMinimalComponents } from './components'
import { buildCustomShadows, buildShadows, type MinimalCustomShadows } from './shadows'
import { MINIMAL_GREY, SEMANTIC_SCALES, type SemanticColor, type SemanticScale } from './tokens'
import { minimalTypography } from './typography'

// ---------------------------------------------------------------------------
// Module augmentation: lighter/darker shades, custom shadows, soft variants.
// ---------------------------------------------------------------------------

declare module '@mui/material/styles' {
  interface PaletteColor {
    lighter?: string
    darker?: string
  }
  interface SimplePaletteColorOptions {
    lighter?: string
    darker?: string
  }
  interface Theme {
    customShadows: MinimalCustomShadows
  }
  interface ThemeOptions {
    customShadows?: MinimalCustomShadows
  }
}

declare module '@mui/material/Button' {
  interface ButtonPropsVariantOverrides {
    soft: true
  }
}

declare module '@mui/material/Chip' {
  interface ChipPropsVariantOverrides {
    soft: true
  }
}

// ---------------------------------------------------------------------------

function semanticPalette(color: SemanticColor, isDark: boolean): PaletteColorOptions {
  const scale = SEMANTIC_SCALES[color]
  return {
    lighter: scale.lighter,
    light: scale.light,
    main: scale.main,
    dark: scale.dark,
    darker: scale.darker,
    contrastText: isDark || color === 'warning' ? MINIMAL_GREY[800] : '#FFFFFF'
  }
}

export function createMinimalTheme(mode: 'light' | 'dark'): Theme {
  const isDark = mode === 'dark'

  const palette: ThemeOptions['palette'] = {
    mode,
    primary: semanticPalette('primary', isDark),
    secondary: semanticPalette('secondary', isDark),
    info: semanticPalette('info', isDark),
    success: semanticPalette('success', isDark),
    warning: semanticPalette('warning', isDark),
    error: semanticPalette('error', isDark),
    grey: MINIMAL_GREY,
    divider: alpha(MINIMAL_GREY[500], isDark ? 0.2 : 0.2),
    text: {
      primary: isDark ? '#FFFFFF' : MINIMAL_GREY[800],
      secondary: isDark ? MINIMAL_GREY[500] : MINIMAL_GREY[600],
      disabled: isDark ? MINIMAL_GREY[600] : MINIMAL_GREY[400]
    },
    background: {
      default: isDark ? '#0D1218' : '#FFFFFF',
      paper: isDark ? MINIMAL_GREY[900] : '#FFFFFF'
    },
    action: {
      active: isDark ? MINIMAL_GREY[400] : MINIMAL_GREY[600],
      hover: alpha(MINIMAL_GREY[500], 0.08),
      selected: alpha(MINIMAL_GREY[500], 0.16),
      disabled: alpha(MINIMAL_GREY[500], 0.48),
      disabledBackground: alpha(MINIMAL_GREY[500], 0.24),
      focus: alpha(MINIMAL_GREY[500], 0.24)
    }
  }

  const base = createTheme({
    palette,
    typography: minimalTypography,
    shape: { borderRadius: 8 },
    shadows: buildShadows(isDark),
    customShadows: buildCustomShadows(isDark)
  })

  return createTheme(base, { components: buildMinimalComponents(isDark) })
}

export { MINIMAL_GREY, SEMANTIC_SCALES }
export type { SemanticColor, SemanticScale }
