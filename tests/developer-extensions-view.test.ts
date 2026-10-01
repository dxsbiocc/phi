import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import {
  DeveloperExtensionsManager,
  DeveloperExtensionsSidebar
} from '../src/renderer/src/features/developer-extensions/DeveloperExtensionsView'
import type { PluginCatalogItem } from '../src/renderer/src/types'

const extension: PluginCatalogItem = {
  id: 'plugin-1',
  name: '@phi/example',
  source: 'npm:@phi/example',
  description: 'Example developer extension',
  author: 'Phi',
  kind: 'package',
  homepageUrl: 'https://pi.dev/packages/%40phi/example',
  npmUrl: 'https://www.npmjs.com/package/@phi/example',
  installed: false
}

function renderDeveloperExtensionsManager(
  operationError: string | null,
  extensionOverride: Partial<PluginCatalogItem> = {}
): string {
  const selectedExtension = { ...extension, ...extensionOverride }
  const theme = createTheme({
    components: { MuiDialog: { defaultProps: { disablePortal: true } } }
  })
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme },
      createElement(DeveloperExtensionsManager, {
        extensions: [selectedExtension],
        isLoading: false,
        activeExtensionId: selectedExtension.id,
        busySource: null,
        operationError,
        onSelectExtension: () => undefined,
        onInstall: () => undefined,
        onRemove: () => undefined,
        onRefresh: () => undefined
      })
    )
  )
}

test('developer extensions view keeps operation failures visible in the selected detail', () => {
  const markup = renderDeveloperExtensionsManager('install failed')
  assert.match(markup, /install failed/)
  assert.match(markup, /npm:@phi\/example/)
  assert.match(markup, /安装/)
  assert.match(markup, /开发者扩展/)
})

test('developer extensions view shows source, installed state, and installed path', () => {
  const markup = renderDeveloperExtensionsManager(null, {
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

test('developer extensions sidebar has no selected row after its detail closes', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(DeveloperExtensionsSidebar, {
        extensions: [extension],
        isLoading: false,
        activeExtensionId: null,
        onSelectExtension: () => undefined,
        onRefresh: () => undefined
      })
    )
  )
  assert.equal(markup.match(/class="[^"]*Mui-selected[^"]*"/g)?.length ?? 0, 0)
})
