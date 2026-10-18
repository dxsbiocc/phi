import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'

import { RemoteHostSettingsSection } from '../src/renderer/src/features/wrapper/components/RemoteHostSettings'
import { RemoteHostDialog } from '../src/renderer/src/features/wrapper/components/RemoteHostDialog'

test('remote settings manages SSH servers without showing local project bindings', () => {
  const markup = renderToStaticMarkup(
    createElement(ThemeProvider, { theme: createTheme() }, createElement(RemoteHostSettingsSection))
  )

  assert.match(markup, /SSH server/)
  assert.match(markup, /Select a server to manage its runtime environment/)
  assert.match(markup, /Add server/)
  assert.doesNotMatch(markup, /Configure remote Wrappers for local projects/)
  assert.doesNotMatch(markup, /Add connection/)
  assert.doesNotMatch(markup, /Default connection/)
})

test('a new OpenSSH host defaults to passwordless authentication', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      {
        theme: createTheme({
          components: { MuiDialog: { defaultProps: { disablePortal: true } } }
        })
      },
      createElement(RemoteHostDialog, {
        open: true,
        draft: {
          id: '',
          label: 'lab-hpc',
          hostAlias: 'lab-hpc',
          hostname: 'compute.example.invalid',
          user: 'scientist',
          port: '22',
          identityFile: '',
          source: 'ssh-config'
        },
        busy: false,
        error: null,
        onDraftChange: () => undefined,
        onClose: () => undefined,
        onSave: () => undefined,
        onPasswordBootstrap: () => undefined
      })
    )
  )

  assert.match(markup, /Authentication/)
  assert.match(markup, /Key-based login \(recommended\)/)
  assert.match(markup, /Use existing SSH configuration/)
  assert.match(markup, /checked=""[^>]*value="passwordless"|value="passwordless"[^>]*checked=""/)
  assert.match(markup, /Continue key-based login setup/)
  assert.doesNotMatch(markup, /Private key path/)
  assert.doesNotMatch(markup, /Set up key-based login with a password/)
})

test('existing SSH authentication reveals the optional identity file', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      {
        theme: createTheme({
          components: { MuiDialog: { defaultProps: { disablePortal: true } } }
        })
      },
      createElement(RemoteHostDialog, {
        open: true,
        draft: {
          id: '',
          label: 'lab-hpc',
          hostAlias: 'lab-hpc',
          hostname: 'compute.example.invalid',
          user: 'scientist',
          port: '22',
          identityFile: '',
          source: 'ssh-config',
          authMode: 'existing-key'
        },
        busy: false,
        error: null,
        onDraftChange: () => undefined,
        onClose: () => undefined,
        onSave: () => undefined,
        onPasswordBootstrap: () => undefined
      })
    )
  )

  assert.match(markup, /Private key path \(optional\)/)
  assert.match(markup, />Add server</)
  assert.doesNotMatch(markup, /Continue key-based login setup/)
})
