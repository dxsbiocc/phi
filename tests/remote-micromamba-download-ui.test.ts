import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { it } from 'node:test'

import { ThemeProvider, createTheme } from '@mui/material/styles'

import { RemoteMicromambaControl } from '../src/renderer/src/features/wrapper/components/RemoteMicromambaControl'
import { CAPABILITY_PROFILE } from './helpers/remoteRuntimeRootUiFixtures'

it('shows the probed capability and selected transfer method', () => {
  const control = createElement(RemoteMicromambaControl, {
    capabilityProfile: {
      ...CAPABILITY_PROFILE,
      runtimeRoot: {
        ...CAPABILITY_PROFILE.runtimeRoot!,
        micromamba: {
          status: 'not-installed',
          download: { status: 'reachable', tool: 'curl', host: 'gh-proxy.com' }
        }
      }
    },
    runtimeRoot: '~/.phi/runtime',
    state: {
      phase: 'done',
      result: {
        status: 'installed',
        version: '2.9.0-0',
        platform: 'linux-x64',
        durationMs: 20,
        warningCodes: [],
        message: 'Remote micromamba installed and verified.',
        transferMethod: 'remote-direct'
      }
    },
    onInstall: () => undefined
  })
  const markup = renderToStaticMarkup(
    createElement(ThemeProvider, { theme: createTheme() }, control)
  )

  assert.match(markup, /Last reachable source: gh-proxy.com \(curl\)/)
  assert.match(markup, /Installation method: Direct server download/)
})
