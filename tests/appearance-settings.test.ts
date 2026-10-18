import { beforeEach, afterEach } from 'node:test'
import { setUiLanguage } from '../src/renderer/src/lib/i18n'

// Keep these legacy behavioral assertions explicit about their presentation language.
beforeEach(() => setUiLanguage('zh-CN'))
afterEach(() => setUiLanguage('en'))

import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThemeProvider } from '@mui/material'

import { AppearanceSettingsSection } from '../src/renderer/src/features/settings/components/AppearanceSettingsSection'
import { createPaletteTheme, type EffectiveMode, type ThemeMode } from '../src/renderer/src/theme'
import {
  THEME_PALETTES,
  THEME_PALETTE_IDS,
  themePalettePreviewColors,
  type ThemePaletteId
} from '../src/renderer/src/themePalettes'

function renderAppearance(
  palette: ThemePaletteId,
  effectiveMode: EffectiveMode = 'light',
  mode: ThemeMode = 'system'
): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createPaletteTheme(effectiveMode, palette) },
      createElement(AppearanceSettingsSection, {
        palette,
        mode,
        onSelectPalette: () => undefined,
        onSelectMode: () => undefined
      })
    )
  )
}

test('appearance exposes every palette as one accessible native radio group', () => {
  const markup = renderAppearance('minimal')
  const groupLabel = markup.match(/<label[^>]*id="([^"]+)"[^>]*>配色<\/label>/)
  assert.ok(groupLabel)
  assert.ok(markup.includes(`role="radiogroup" aria-labelledby="${groupLabel[1]}"`))

  const paletteRadios = markup.match(/<input\b[^>]*name="theme-palette"[^>]*>/g) ?? []
  assert.equal(paletteRadios.length, THEME_PALETTES.length)
  for (const palette of THEME_PALETTES) {
    assert.ok(markup.includes(palette.label.replace('&', '&amp;')))
    assert.ok(markup.includes(`value="${palette.id}"`))
    assert.ok(markup.includes(`background-color:${themePalettePreviewColors(palette)[0]};`))
  }
})

test('appearance reflects every controlled palette selection exclusively', () => {
  for (const palette of THEME_PALETTE_IDS) {
    const radios = renderAppearance(palette).match(/<input\b[^>]*name="theme-palette"[^>]*>/g) ?? []
    assert.equal(radios.filter((radio) => radio.includes('checked=""')).length, 1)
    assert.ok(radios.find((radio) => radio.includes('checked=""'))?.includes(`value="${palette}"`))
  }
})

test('every palette creates usable light and dark Minimal themes', () => {
  for (const mode of ['light', 'dark'] as const) {
    for (const palette of THEME_PALETTE_IDS) {
      const theme = createPaletteTheme(mode, palette)
      assert.equal(theme.palette.mode, mode)
      assert.match(theme.palette.primary.main, /^(#[0-9A-F]{6}|rgb\(.+\))$/i)
      assert.match(theme.palette.background.default, /^#[0-9A-F]{6}$/i)
      assert.notEqual(theme.palette.text.primary, theme.palette.background.default)
    }
  }
})

test('brightness choices are native radio rows with one active preference', () => {
  for (const mode of ['light', 'dark', 'system'] as const) {
    const markup = renderAppearance('minimal', 'dark', mode)
    for (const label of ['浅色', '深色', '跟随系统']) assert.ok(markup.includes(label))
    const radios = markup.match(/<input\b[^>]*name="theme-mode"[^>]*>/g) ?? []
    assert.equal(radios.length, 3)
    assert.equal(radios.filter((radio) => radio.includes('checked=""')).length, 1)
    assert.ok(radios.find((radio) => radio.includes('checked=""'))?.includes(`value="${mode}"`))
    assert.doesNotMatch(markup, /aria-pressed=/)
  }
})
