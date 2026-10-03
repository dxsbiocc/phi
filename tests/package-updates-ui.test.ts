import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'

import { PackageUpdatesDialog } from '../src/renderer/src/components/PackageUpdatesDialog'

test('updates dialog shows versions, source, tier, and individual/all actions', () => {
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
  assert.match(markup, /\/registries\/alpha/)
  assert.match(markup, /官方/)
  assert.match(markup, /全部更新/)
  assert.match(markup, />更新</)
})
