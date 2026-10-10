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
          message: '远端已有系统 ripgrep。'
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
          message: '远端受管 ripgrep 已安装且可运行。'
        }
      },
      onInstall: () => undefined
    })

    assert.match(system, /已有系统 rg（14\.1\.1）/)
    assert.match(system, /安装受管版本/)
    assert.match(managed, /受管 rg（14\.1\.1）/)
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
          message: '已有系统版本。'
        }
      },
      onInstall: (...args) => calls.push(args)
    }
    const systemControl = RemoteRipgrepControl(systemProps)
    const systemButton = (systemControl.props as { children: React.ReactElement[] }).children[2]
    ;(systemButton.props as { onClick: () => void }).onClick()

    const warningProps: RemoteRipgrepControlProps = {
      state: {
        phase: 'done',
        result: {
          status: 'needs-confirmation',
          durationMs: 1,
          warningCodes: ['noexec'],
          message: '需要确认。'
        }
      },
      onInstall: (...args) => calls.push(args)
    }
    const warningControl = RemoteRipgrepControl(warningProps)
    const warningButton = (warningControl.props as { children: React.ReactElement[] }).children[2]
    ;(warningButton.props as { onClick: () => void }).onClick()

    assert.deepEqual(calls, [
      [undefined, true],
      [['noexec'], false]
    ])
    assert.match(render(warningProps), />仍然使用</)
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

    assert.match(markup, /micromamba 路径/)
    assert.doesNotMatch(markup, /安装\/更新 micromamba/)
    assert.doesNotMatch(markup, /安装 ripgrep/)
    assert.doesNotMatch(markup, /运行时根目录必须/)
  })
})
