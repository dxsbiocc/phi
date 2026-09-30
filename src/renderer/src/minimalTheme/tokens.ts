/**
 * Design tokens for the Minimal-style theme.
 * Values come from the visual reference in
 * `docs/design/minimal-style-reference/README.md`.
 */

export const MINIMAL_GREY = {
  50: '#FCFDFD',
  100: '#F9FAFB',
  200: '#F4F6F8',
  300: '#DFE3E8',
  400: '#C4CDD5',
  500: '#919EAB',
  600: '#637381',
  700: '#454F5B',
  800: '#1C252E',
  900: '#141A21'
} as const

export interface SemanticScale {
  lighter: string
  light: string
  main: string
  dark: string
  darker: string
}

export const MINIMAL_PRIMARY: SemanticScale = {
  lighter: '#C8FAD6',
  light: '#5BE49B',
  main: '#00A76F',
  dark: '#007867',
  darker: '#004B50'
}

export const MINIMAL_SECONDARY: SemanticScale = {
  lighter: '#EFD6FF',
  light: '#C684FF',
  main: '#8E33FF',
  dark: '#5119B7',
  darker: '#27097A'
}

export const MINIMAL_INFO: SemanticScale = {
  lighter: '#CAFDF5',
  light: '#61F3F3',
  main: '#00B8D9',
  dark: '#006C9C',
  darker: '#003768'
}

export const MINIMAL_SUCCESS: SemanticScale = {
  lighter: '#D3FCD2',
  light: '#77ED8B',
  main: '#22C55E',
  dark: '#118D57',
  darker: '#065E49'
}

export const MINIMAL_WARNING: SemanticScale = {
  lighter: '#FFF5CC',
  light: '#FFD666',
  main: '#FFAB00',
  dark: '#B76E00',
  darker: '#7A4100'
}

export const MINIMAL_ERROR: SemanticScale = {
  lighter: '#FFE9D5',
  light: '#FFAC82',
  main: '#FF5630',
  dark: '#B71D18',
  darker: '#7A0916'
}

export const SEMANTIC_SCALES = {
  primary: MINIMAL_PRIMARY,
  secondary: MINIMAL_SECONDARY,
  info: MINIMAL_INFO,
  success: MINIMAL_SUCCESS,
  warning: MINIMAL_WARNING,
  error: MINIMAL_ERROR
} as const

export type SemanticColor = keyof typeof SEMANTIC_SCALES

export const MINIMAL_FONT_STACK =
  '"DM Sans Variable", "DM Sans", -apple-system, system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
