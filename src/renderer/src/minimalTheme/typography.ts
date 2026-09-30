import type { ThemeOptions } from '@mui/material'

import { MINIMAL_FONT_STACK } from './tokens'

// pxToRem on a 16px root, matching the observed type scale.
const HTML_FONT_SIZE = 16

export function pxToRem(px: number): string {
  return `${px / HTML_FONT_SIZE}rem`
}

export const minimalTypography: ThemeOptions['typography'] = {
  fontFamily: MINIMAL_FONT_STACK,
  fontWeightRegular: 400,
  fontWeightMedium: 500,
  fontWeightBold: 700,
  h1: { fontSize: pxToRem(64), fontWeight: 800, lineHeight: 80 / 64 },
  h2: { fontSize: pxToRem(48), fontWeight: 800, lineHeight: 64 / 48 },
  h3: { fontSize: pxToRem(32), fontWeight: 700, lineHeight: 1.5 },
  h4: { fontSize: pxToRem(24), fontWeight: 700, lineHeight: 1.5 },
  h5: { fontSize: pxToRem(19), fontWeight: 700, lineHeight: 1.5 },
  h6: { fontSize: pxToRem(18), fontWeight: 600, lineHeight: 28 / 18 },
  subtitle1: { fontSize: pxToRem(16), fontWeight: 600, lineHeight: 1.5 },
  subtitle2: { fontSize: pxToRem(14), fontWeight: 600, lineHeight: 22 / 14 },
  body1: { fontSize: pxToRem(16), fontWeight: 400, lineHeight: 1.5 },
  body2: { fontSize: pxToRem(14), fontWeight: 400, lineHeight: 22 / 14 },
  caption: { fontSize: pxToRem(12), fontWeight: 400, lineHeight: 1.5 },
  overline: {
    fontSize: pxToRem(12),
    fontWeight: 700,
    lineHeight: 1.5,
    textTransform: 'uppercase'
  },
  button: { fontSize: pxToRem(14), fontWeight: 700, textTransform: 'none' }
}
