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

  assert.match(markup, /SSH 服务器/)
  assert.match(markup, /选择服务器后管理运行环境/)
  assert.match(markup, /添加服务器/)
  assert.doesNotMatch(markup, /为本地项目配置远程 Wrapper/)
  assert.doesNotMatch(markup, /添加连接/)
  assert.doesNotMatch(markup, /默认连接/)
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

  assert.match(markup, /认证方式/)
  assert.match(markup, /免密登录（推荐）/)
  assert.match(markup, /使用现有 SSH 配置/)
  assert.match(markup, /checked=""[^>]*value="passwordless"|value="passwordless"[^>]*checked=""/)
  assert.match(markup, /继续设置免密登录/)
  assert.doesNotMatch(markup, /私钥路径/)
  assert.doesNotMatch(markup, /用密码设置免密登录/)
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

  assert.match(markup, /私钥路径（可选）/)
  assert.match(markup, />添加服务器</)
  assert.doesNotMatch(markup, /继续设置免密登录/)
})
