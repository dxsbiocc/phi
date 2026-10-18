import { captureWrapperUi } from './helpers/captureWrapperUi'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it } from 'node:test'

import { ThemeProvider, createTheme } from '@mui/material/styles'

import { RemoteHostEnvironmentEditor } from '../src/renderer/src/features/wrapper/components/RemoteHostEnvironmentEditor'
import {
  RemoteRipgrepControl,
  type RemoteRipgrepControlProps
} from '../src/renderer/src/features/wrapper/components/RemoteRipgrepControl'
import { HOST } from './helpers/remoteRuntimeRootUiFixtures'

function render(props: RemoteRipgrepControlProps): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(RemoteRipgrepControl, props)
    )
  )
}

describe('remote ripgrep settings UI', () => {
  it('distinguishes system and managed installations without exposing paths', () => {
    const system = render({
      state: {
        phase: 'done',
        result: {
          status: 'system',
          executablePath: '/home/secret/bin/rg',
          version: '14.1.1',
          durationMs: 1,
          message: 'System ripgrep is available on the server.'
        }
      },
      onInstall: () => undefined
    })
    const managed = render({
      state: {
        phase: 'done',
        result: {
          status: 'managed',
          executablePath: '/home/secret/runtime/tools/ripgrep-14.1.1/bin/rg',
          version: '14.1.1',
          durationMs: 1,
          message: 'Managed ripgrep is installed and usable on the server.'
        }
      },
      onInstall: () => undefined
    })

    assert.match(system, /System rg \(14\.1\.1\)/)
    assert.match(system, /Install managed version/)
    assert.match(managed, /Managed rg \(14\.1\.1\)/)
    assert.doesNotMatch(`${system}${managed}`, /home\/secret/)
  })

  it('passes warning confirmation and force-managed intent only after a click', () => {
    const calls: unknown[] = []
    const systemProps: RemoteRipgrepControlProps = {
      state: {
        phase: 'done',
        result: {
          status: 'system',
          version: '14.1.1',
          durationMs: 1,
          message: 'A system version is available.'
        }
      },
      onInstall: (...args) => calls.push(args)
    }
    const systemControl = captureWrapperUi(() => RemoteRipgrepControl(systemProps))
    const systemButton = (systemControl.props as { children: React.ReactElement[] }).children[2]
    ;(systemButton.props as { onClick: () => void }).onClick()

    const warningProps: RemoteRipgrepControlProps = {
      state: {
        phase: 'done',
        result: {
          status: 'needs-confirmation',
          durationMs: 1,
          warningCodes: ['noexec'],
          message: 'Confirmation required.'
        }
      },
      onInstall: (...args) => calls.push(args)
    }
    const warningControl = captureWrapperUi(() => RemoteRipgrepControl(warningProps))
    const warningButton = (warningControl.props as { children: React.ReactElement[] }).children[2]
    ;(warningButton.props as { onClick: () => void }).onClick()

    assert.deepEqual(calls, [
      [undefined, true],
      [['noexec'], false]
    ])
    assert.match(render(warningProps), />Use anyway</)
  })

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
