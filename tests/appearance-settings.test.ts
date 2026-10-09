import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThemeProvider } from '@mui/material'
import { AppearanceSettingsSection } from '../src/renderer/src/features/settings/components/AppearanceSettingsSection'
import { createAppTheme, type EffectiveMode, type ThemeMode } from '../src/renderer/src/theme'
import { createMinimalTheme } from '../src/renderer/src/minimalTheme'
import type { ThemeFamily } from '../src/renderer/src/useThemeMode'

function renderAppearance(
  family: ThemeFamily,
  effectiveMode: EffectiveMode = 'light',
  mode: ThemeMode = 'system'
): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createMinimalTheme(effectiveMode) },
      createElement(AppearanceSettingsSection, {
        family,
        mode,
        onSelectFamily: () => undefined,
        onSelectMode: () => undefined
      })
    )
  )
}

test('appearance theme choices are one labeled native radio group with whole-row labels', () => {
  const markup = renderAppearance('minimal')
  const groupLabel = markup.match(/<label[^>]*id="([^"]+)"[^>]*>主题风格<\/label>/)
  assert.ok(groupLabel)
  assert.ok(markup.includes(`role="radiogroup" aria-labelledby="${groupLabel[1]}"`))

  const rows = [...markup.matchAll(/<label\b[^>]*>(.*?)<\/label>/gs)]
    .map((match) => match[1])
    .filter((row) => row.includes('type="radio"'))
  assert.equal(rows.length, 2)
  for (const [index, label] of ['默认', 'Minimal 风格'].entries()) {
    assert.ok(rows[index].includes(label))
    assert.ok(rows[index].includes('name="theme-family"'))
    assert.ok(rows[index].includes('aria-hidden="true"'))
  }
})

test('appearance reflects the saved family exclusively and updates its controlled selection', () => {
  for (const family of ['default', 'minimal'] as const) {
    const radios = renderAppearance(family).match(/<input\b[^>]*type="radio"[^>]*>/g) ?? []
    assert.equal(radios.length, 2)
    assert.equal(radios.filter((radio) => radio.includes('checked=""')).length, 1)
    const checked = radios.find((radio) => radio.includes('checked=""'))
    assert.ok(checked?.includes(`value="${family}"`))
  }
})

test('appearance previews use each real theme palette in the effective light and dark mode', () => {
  for (const mode of ['light', 'dark'] as const) {
    const markup = renderAppearance('minimal', mode)
    for (const theme of [createAppTheme(mode), createMinimalTheme(mode)]) {
      const palette = theme.palette
      for (const color of [
        palette.primary.main,
        palette.background.default,
        palette.info.main,
        palette.warning.main,
        palette.error.main
      ]) {
        assert.ok(markup.includes(`background-color:${color};`), `${mode} preview lacks ${color}`)
      }
    }
  }
})

test('appearance keeps all brightness choices and the active preference', () => {
  for (const mode of ['light', 'dark', 'system'] as const) {
    const markup = renderAppearance('minimal', 'dark', mode)
    for (const label of ['浅色', '深色', '跟随系统']) assert.ok(markup.includes(label))
    const buttons = markup.match(/<button\b[^>]*>/g) ?? []
    const selected = buttons.filter((button) => button.includes('aria-pressed="true"'))
    assert.equal(selected.length, 1)
    assert.ok(selected[0].includes(`value="${mode}"`))
  }
})
