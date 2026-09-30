import type { Theme } from '@mui/material'

/**
 * Shadows use the standard elevation offset tables re-colored with grey-500
 * instead of black — that grey-blue tint is what gives this style its soft
 * elevation. Dark mode doubles the opacity on pure black instead.
 */

const UMBRA: Array<[number, number, number, number]> = [
  [0, 2, 1, -1],
  [0, 3, 1, -2],
  [0, 3, 3, -2],
  [0, 2, 4, -1],
  [0, 3, 5, -1],
  [0, 3, 5, -1],
  [0, 4, 5, -2],
  [0, 5, 5, -3],
  [0, 5, 6, -3],
  [0, 6, 6, -3],
  [0, 6, 7, -4],
  [0, 7, 8, -4],
  [0, 7, 8, -4],
  [0, 7, 9, -4],
  [0, 8, 9, -5],
  [0, 8, 10, -5],
  [0, 8, 11, -5],
  [0, 9, 11, -5],
  [0, 9, 12, -6],
  [0, 10, 13, -6],
  [0, 10, 13, -6],
  [0, 10, 14, -6],
  [0, 11, 14, -7],
  [0, 11, 15, -7]
]

const PENUMBRA: Array<[number, number, number, number]> = [
  [0, 1, 1, 0],
  [0, 2, 2, 0],
  [0, 3, 4, 0],
  [0, 4, 5, 0],
  [0, 5, 8, 0],
  [0, 6, 10, 0],
  [0, 7, 10, 1],
  [0, 8, 10, 1],
  [0, 9, 12, 1],
  [0, 10, 14, 1],
  [0, 11, 15, 1],
  [0, 12, 17, 2],
  [0, 13, 19, 2],
  [0, 14, 21, 2],
  [0, 15, 22, 2],
  [0, 16, 24, 2],
  [0, 17, 26, 2],
  [0, 18, 28, 2],
  [0, 18, 29, 2],
  [0, 19, 31, 3],
  [0, 20, 33, 3],
  [0, 21, 35, 3],
  [0, 22, 36, 3],
  [0, 23, 38, 3]
]

const AMBIENT: Array<[number, number, number, number]> = [
  [0, 1, 3, 0],
  [0, 1, 5, 0],
  [0, 1, 8, 0],
  [0, 1, 10, 0],
  [0, 1, 14, 0],
  [0, 1, 18, 0],
  [0, 2, 16, 1],
  [0, 3, 14, 2],
  [0, 3, 16, 2],
  [0, 4, 18, 3],
  [0, 4, 20, 3],
  [0, 5, 22, 4],
  [0, 5, 24, 4],
  [0, 5, 26, 4],
  [0, 6, 28, 5],
  [0, 6, 30, 5],
  [0, 6, 32, 5],
  [0, 7, 34, 6],
  [0, 7, 36, 6],
  [0, 8, 38, 7],
  [0, 8, 40, 7],
  [0, 8, 42, 7],
  [0, 9, 44, 8],
  [0, 9, 46, 8]
]

function shadowChannel(isDark: boolean): string {
  return isDark ? '0, 0, 0' : '145, 158, 171'
}

export function buildShadows(isDark: boolean): Theme['shadows'] {
  const channel = shadowChannel(isDark)
  const [u, p, a] = isDark ? [0.4, 0.28, 0.24] : [0.2, 0.14, 0.12]
  const shadows = UMBRA.map(([x, y, blur, spread], i) => {
    const [px, py, pBlur, pSpread] = PENUMBRA[i]
    const [ax, ay, aBlur, aSpread] = AMBIENT[i]
    return [
      `${x}px ${y}px ${blur}px ${spread}px rgba(${channel}, ${u})`,
      `${px}px ${py}px ${pBlur}px ${pSpread}px rgba(${channel}, ${p})`,
      `${ax}px ${ay}px ${aBlur}px ${aSpread}px rgba(${channel}, ${a})`
    ].join(', ')
  })
  return ['none', ...shadows] as Theme['shadows']
}

export interface MinimalCustomShadows {
  card: string
  dropdown: string
  dialog: string
}

export function buildCustomShadows(isDark: boolean): MinimalCustomShadows {
  const channel = shadowChannel(isDark)
  const soft = isDark ? 0.24 : 0.2
  const softer = isDark ? 0.16 : 0.12
  return {
    card: `0 0 2px rgba(${channel}, ${soft}), 0 12px 24px -4px rgba(${channel}, ${softer})`,
    dropdown: `0 0 2px rgba(${channel}, ${soft}), 0 20px 40px -4px rgba(${channel}, ${softer})`,
    dialog: `0 0 2px rgba(${channel}, ${soft}), 0 24px 48px -12px rgba(${channel}, ${softer})`
  }
}
