import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import PluginView, { PluginSidebar } from '../src/renderer/src/features/plugin/PluginView'
import type { PluginCatalogItem } from '../src/renderer/src/types'

const plugin: PluginCatalogItem = {
  id: 'plugin-1',
  name: '@phi/example',
  source: 'npm:@phi/example',
  description: 'Example plugin',
  author: 'Phi',
  kind: 'package',
  homepageUrl: 'https://pi.dev/packages/%40phi/example',
  npmUrl: 'https://www.npmjs.com/package/@phi/example',
  installed: false
}

function renderPluginView(
  operationError: string | null,
  pluginOverride: Partial<PluginCatalogItem> = {}
): string {
  const selectedPlugin = { ...plugin, ...pluginOverride }
  const theme = createTheme({
    components: { MuiDialog: { defaultProps: { disablePortal: true } } }
  })
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme },
      createElement(PluginView, {
        plugins: [selectedPlugin],
        isLoading: false,
        activePluginId: selectedPlugin.id,
        busySource: null,
        operationError,
        sidebarWidth: 320,
        onSelectPlugin: () => undefined,
        onInstall: () => undefined,
        onRemove: () => undefined,
        onRefresh: () => undefined,
        onStartSidebarResize: () => undefined
      })
    )
  )
}

test('plugin view keeps operation failures visible in the selected plugin detail', () => {
  const markup = renderPluginView('install failed')
  assert.match(markup, /install failed/)
  assert.match(markup, /npm:@phi\/example/)
  assert.match(markup, /安装/)
})

test('plugin view shows source, installed state, and installed path', () => {
  const markup = renderPluginView(null, {
    installed: true,
    installedPath: '/Users/example/.phi/plugins/@phi/example'
  })

  assert.match(markup, /已安装/)
  assert.match(markup, /安装源/)
  assert.match(markup, /pi install npm:@phi\/example/)
  assert.match(markup, /本地路径/)
  assert.match(markup, /\/Users\/example\/\.phi\/plugins\/@phi\/example/)
  assert.match(markup, /卸载/)
})

test('plugin sidebar has no selected row after its detail tab closes', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(PluginSidebar, {
        plugins: [plugin],
        isLoading: false,
        activePluginId: null,
        onSelectPlugin: () => undefined,
        onRefresh: () => undefined
      })
    )
  )
  assert.equal(markup.match(/class="[^"]*Mui-selected[^"]*"/g)?.length ?? 0, 0)
})
