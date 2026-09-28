import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'

import { RemoteHostSettingsSection } from '../src/renderer/src/features/wrapper/components/RemoteHostSettings'

test('remote settings manages SSH servers without showing local project bindings', () => {
  const markup = renderToStaticMarkup(
    createElement(ThemeProvider, { theme: createTheme() }, createElement(RemoteHostSettingsSection))
  )

  assert.match(markup, /SSH 服务器/)
  assert.match(markup, /新建远程项目时选择服务器和目录/)
  assert.match(markup, /添加服务器/)
  assert.doesNotMatch(markup, /为本地项目配置远程 Wrapper/)
  assert.doesNotMatch(markup, /添加连接/)
  assert.doesNotMatch(markup, /默认连接/)
})
