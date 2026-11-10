import { beforeEach, afterEach } from 'node:test'
import { setUiLanguage } from '../src/renderer/src/lib/i18n'

// Keep these legacy behavioral assertions explicit about their presentation language.
beforeEach(() => setUiLanguage('zh-CN'))
afterEach(() => setUiLanguage('en'))

import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'

import { PackageUpdateDialog } from '../src/renderer/src/components/PackageUpdateDialog'
import type { PackageUpdateView } from '../src/shared/packageManagerTypes'

function renderDialog(update: PackageUpdateView | null): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      {
        theme: createTheme({
          components: { MuiDialog: { defaultProps: { disablePortal: true } } }
        })
      },
      createElement(PackageUpdateDialog, {
        open: true,
        update,
        busy: false,
        error: null,
        onClose: () => undefined,
        onApply: () => undefined
      })
    )
  )
}

test('single-package dialog shows title, versions, notes, tier, and one update action', () => {
  const markup = renderDialog({
    id: 'alpha-skill',
    type: 'skill',
    title: 'Alpha skill',
    currentVersion: '1.0.0',
    newVersion: '1.1.0',
    registryId: '0123456789abcdef',
    registryPath: '/registries/alpha',
    trust: 'official'
  })

  assert.match(markup, /内容包更新/)
  assert.match(markup, /Alpha skill/)
  assert.match(markup, /1\.0\.0.*1\.1\.0/)
  assert.match(markup, /更新内容/)
  assert.match(markup, /此版本没有提供更新说明/)
  assert.doesNotMatch(markup, /\/registries\/alpha/)
  assert.match(markup, /官方/)
  assert.doesNotMatch(markup, /全部更新/)
  assert.equal((markup.match(/>更新<\/button>/g) ?? []).length, 1)
})

test('plugin updates use the display title and render every changelog version', () => {
  const longNotes = Array.from({ length: 20 }, (_, index) => `Line ${index + 1}`).join('\n')
  const markup = renderDialog({
    id: 'visualization',
    type: 'plugin',
    title: '科研绘图',
    currentVersion: '0.6.0',
    newVersion: '0.7.0',
    registryId: '0123456789abcdef',
    registryPath: '/registries/alpha',
    trust: 'official',
    summary: 'Plotting package.',
    changes: [
      { version: '0.7.0', notes: longNotes },
      { version: '0.6.5', notes: 'Small fix.' }
    ]
  })

  assert.match(markup, /Visualization/)
  assert.doesNotMatch(markup, /科研绘图/)
  assert.doesNotMatch(markup, /\/registries\/alpha/)
  assert.match(markup, /0\.7\.0/)
  assert.match(markup, /0\.6\.5/)
  assert.match(markup, /Line 20/)
  assert.match(markup, /展开/)
  assert.doesNotMatch(markup, /此版本没有提供更新说明/)
  assert.doesNotMatch(markup, /全部更新/)
})

test('renders typed changelog changes as release accordions with chips and dates', () => {
  const markup = renderDialog({
    id: 'literature-library',
    type: 'plugin',
    title: '文献库',
    currentVersion: '0.6.0',
    newVersion: '0.7.0',
    registryId: '0123456789abcdef',
    registryPath: '/registries/alpha',
    trust: 'official',
    changes: [
      {
        version: '0.7.0',
        date: '2026-11-03',
        notes: `Intro for 0.7.0.

### Added

- Added **PubMed** search support.

### Removed

- Removed the legacy flag.`
      },
      {
        version: '0.6.5',
        notes: `### Fixed

- Fixed a crash.`
      }
    ]
  })

  assert.match(markup, /更新内容/)
  assert.match(markup, /2 个版本/)
  assert.match(markup, /最新/)
  assert.match(markup, /不兼容/)
  assert.match(markup, /新增/)
  assert.match(markup, /修复/)
  assert.match(markup, /其他说明/)
  assert.match(markup, /PubMed/)
  assert.match(markup, /2026/)
  assert.match(markup, /0\.7\.0/)
  assert.match(markup, /0\.6\.5/)
})

test('imported updates do not show an unsigned trust chip', () => {
  const markup = renderDialog({
    id: 'alpha-skill',
    type: 'skill',
    title: 'Alpha skill',
    currentVersion: '1.0.0',
    newVersion: '1.1.0',
    registryId: '0123456789abcdef',
    registryPath: '/registries/alpha',
    trust: 'imported'
  })

  assert.match(markup, /Alpha skill/)
  assert.doesNotMatch(markup, /未签名|Unsigned/)
})

test('a closed dialog without a selected package renders no update action', () => {
  const markup = renderDialog(null)
  assert.doesNotMatch(markup, />更新<\/button>/)
})
