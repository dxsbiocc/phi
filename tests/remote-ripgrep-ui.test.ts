import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it } from 'node:test'

import { ThemeProvider, createTheme } from '@mui/material/styles'

import { RemoteHostEnvironmentEditor } from '../src/renderer/src/features/wrapper/components/RemoteHostEnvironmentEditor'
import { HOST } from './helpers/remoteRuntimeRootUiFixtures'

describe('remote ripgrep settings UI', () => {
  it('keeps installation controls out of the simplified remote environment form', () => {
    const markup = renderToStaticMarkup(
      createElement(
        ThemeProvider,
        { theme: createTheme() },
        createElement(RemoteHostEnvironmentEditor, {
          host: { ...HOST, runtimeRoot: '~/.phi/runtime' },
          busy: false,
          onSave: () => undefined
        })
      )
    )

    assert.match(markup, /micromamba path/)
    assert.doesNotMatch(markup, /Install \/ update micromamba/)
    assert.doesNotMatch(markup, /Install ripgrep/)
    assert.doesNotMatch(markup, /The runtime root must/)
  })
})
