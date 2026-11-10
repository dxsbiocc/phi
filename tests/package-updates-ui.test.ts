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

import { PackageUpdatesDialog } from '../src/renderer/src/components/PackageUpdatesDialog'

test('updates dialog shows versions, release notes, tier, and individual/all actions', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      {
        theme: createTheme({
          components: { MuiDialog: { defaultProps: { disablePortal: true } } }
        })
      },
      createElement(PackageUpdatesDialog, {
        open: true,
        updates: [
          {
            id: 'alpha-skill',
            type: 'skill',
            title: 'Alpha skill',
            currentVersion: '1.0.0',
            newVersion: '1.1.0',
            registryId: '0123456789abcdef',
            registryPath: '/registries/alpha',
            trust: 'official'
          }
        ],
        busyKey: null,
        error: null,
        onClose: () => undefined,
        onApply: () => undefined,
        onApplyAll: () => undefined
      })
    )
  )

  assert.match(markup, /内容包更新/)
  assert.match(markup, /Alpha skill/)
  assert.match(markup, /1\.0\.0.*1\.1\.0/)
  assert.match(markup, /更新内容/)
  assert.match(markup, /此版本没有提供更新说明/)
  assert.doesNotMatch(markup, /\/registries\/alpha/)
  assert.match(markup, /官方/)
  assert.match(markup, /全部更新/)
  assert.match(markup, />更新</)
})

test('plugin updates use the display title and render every changelog version', () => {
  const longNotes = Array.from({ length: 20 }, (_, index) => `Line ${index + 1}`).join('\n')
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      {
        theme: createTheme({
          components: { MuiDialog: { defaultProps: { disablePortal: true } } }
        })
      },
      createElement(PackageUpdatesDialog, {
        open: true,
        updates: [
          {
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
          }
        ],
        busyKey: null,
        error: null,
        onClose: () => undefined,
        onApply: () => undefined,
        onApplyAll: () => undefined
      })
    )
  )

  assert.match(markup, /Visualization/)
  assert.doesNotMatch(markup, /科研绘图/)
  assert.doesNotMatch(markup, /\/registries\/alpha/)
  assert.match(markup, /0\.7\.0/)
  assert.match(markup, /0\.6\.5/)
  assert.match(markup, /Line 20/)
  assert.match(markup, /展开/)
  assert.doesNotMatch(markup, /此版本没有提供更新说明/)
})

test('imported updates do not show an unsigned trust chip', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      {
        theme: createTheme({
          components: { MuiDialog: { defaultProps: { disablePortal: true } } }
        })
      },
      createElement(PackageUpdatesDialog, {
        open: true,
        updates: [
          {
            id: 'alpha-skill',
            type: 'skill',
            title: 'Alpha skill',
            currentVersion: '1.0.0',
            newVersion: '1.1.0',
            registryId: '0123456789abcdef',
            registryPath: '/registries/alpha',
            trust: 'imported'
          }
        ],
        busyKey: null,
        error: null,
        onClose: () => undefined,
        onApply: () => undefined,
        onApplyAll: () => undefined
      })
    )
  )

  assert.match(markup, /Alpha skill/)
  assert.doesNotMatch(markup, /未签名|Unsigned/)
})
