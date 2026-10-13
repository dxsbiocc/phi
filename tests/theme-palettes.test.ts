import assert from 'node:assert/strict'
import test from 'node:test'
import { getContrastRatio, getLuminance, type Theme } from '@mui/material'

import { createPaletteTheme } from '../src/renderer/src/theme'
import {
  THEME_PALETTES,
  THEME_PALETTE_IDS,
  themePaletteDefinition,
  themePalettePreviewColors
} from '../src/renderer/src/themePalettes'
import { normalizeStoredThemePalette } from '../src/renderer/src/useThemeMode'

const EXPECTED_LOADING_IO_COLORS = {
  plotdb: ['#ED6CA4', '#FBB05B', '#ACD372', '#7BC4E2'],
  aiesec: [
    '#037EF3',
    '#F85A40',
    '#30C39E',
    '#0A8EA0',
    '#F48924',
    '#FFC846',
    '#52565E',
    '#CBCDD1',
    '#F3F4F7'
  ],
  asana: ['#3BE8B0', '#1AAFD0', '#6A67CE', '#FFB900', '#FC636B'],
  wufoo: ['#E66760', '#8C88CD', '#69C5E4', '#FFDF8B', '#61E064'],
  zendesk: ['#00363D', '#F79A3E', '#EB6651', '#30AABC', '#EB4962', '#37B8AF', '#78A300', '#F0CA28'],
  'elastic-search': ['#66B5AE', '#D7689D', '#F3D337', '#5DA4DC', '#A0C443', '#40769E'],
  'chinese-watercolor': [
    '#832F0E',
    '#0C0A08',
    '#594A40',
    '#8E7967',
    '#E3C2A0',
    '#DEAA6E',
    '#81947A'
  ],
  'happiness-cyanide': ['#FACD9E', '#389798', '#459448', '#F19D3B', '#923F2B'],
  'your-name': ['#8CD0E5', '#376888', '#826B88', '#DE786A', '#F8B976', '#FCDDC9']
} as const

test('loading.io palette colors match their official snapshots', () => {
  for (const [id, colors] of Object.entries(EXPECTED_LOADING_IO_COLORS)) {
    assert.deepEqual(
      themePaletteDefinition(id as keyof typeof EXPECTED_LOADING_IO_COLORS).colors,
      colors
    )
  }
})

test('Elastic Search uses its green accent as the primary color', () => {
  assert.equal(themePaletteDefinition('elastic-search').primary, '#A0C443')
  assert.equal(createPaletteTheme('light', 'elastic-search').palette.primary.main, '#A0C443')
})

test('palette previews list the semantic colors actually used by the theme', () => {
  assert.deepEqual(themePalettePreviewColors(themePaletteDefinition('zendesk')), [
    '#37B8AF',
    '#30AABC',
    '#78A300',
    '#F0CA28',
    '#EB4962'
  ])

  for (const palette of THEME_PALETTES) {
    const previewColors = themePalettePreviewColors(palette)
    assert.equal(new Set(previewColors).size, previewColors.length)
    assert.equal(previewColors[0], palette.primary)
  }
})

test('Minimal is the default and legacy theme-family values migrate to it', () => {
  assert.equal(normalizeStoredThemePalette(undefined), 'minimal')
  assert.equal(normalizeStoredThemePalette('default'), 'minimal')
  assert.equal(normalizeStoredThemePalette('minimal'), 'minimal')
  assert.equal(normalizeStoredThemePalette('your-name'), 'your-name')
})

test('all theme palettes have unique ids and loading.io provenance where applicable', () => {
  assert.equal(new Set(THEME_PALETTE_IDS).size, THEME_PALETTES.length)
  for (const palette of THEME_PALETTES) {
    if (palette.id === 'minimal') continue
    assert.match(palette.sourceUrl ?? '', /^https:\/\/loading\.io\/color\/feature\//)
  }
})

test('palette themes retain readable primary controls and body text in both modes', () => {
  for (const mode of ['light', 'dark'] as const) {
    for (const id of THEME_PALETTE_IDS) {
      const theme = createPaletteTheme(mode, id)
      assert.ok(
        getContrastRatio(theme.palette.primary.main, theme.palette.primary.contrastText) >= 4.5,
        `${id}/${mode} primary contrast`
      )
      assert.ok(
        getContrastRatio(theme.palette.background.default, theme.palette.text.primary) >= 4.5,
        `${id}/${mode} body contrast`
      )
    }
  }
})

test('filled primary buttons use lighter surfaces with readable default and hover text', () => {
  type ButtonColors = { backgroundColor: string; color: string }
  type ButtonStyle = ButtonColors & { '&:hover': ButtonColors }

  for (const mode of ['light', 'dark'] as const) {
    for (const id of THEME_PALETTE_IDS) {
      const theme = createPaletteTheme(mode, id)
      const variant = theme.components?.MuiButton?.variants?.find(
        ({ props }) =>
          typeof props !== 'function' && props.variant === 'contained' && props.color === 'primary'
      )
      assert.ok(variant)
      const style = (variant.style as (props: { theme: Theme }) => ButtonStyle)({ theme })
      assert.ok(getLuminance(style.backgroundColor) > getLuminance(theme.palette.primary.main))
      for (const state of [style, style['&:hover']]) {
        assert.ok(
          getContrastRatio(state.backgroundColor, state.color) >= 4.5,
          `${id}/${mode} filled button contrast`
        )
      }
    }
  }
})
