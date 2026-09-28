import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import AddProviderDialog from '../src/renderer/src/components/AddProviderDialog'
import type { ProviderAuthStatus } from '../src/renderer/src/types'

const provider: ProviderAuthStatus = {
  providerId: 'direct-provider',
  name: 'Direct Provider',
  configured: false,
  hasApiKey: true,
  hasOAuth: true,
  hasConfigError: false,
  statusText: '未配置'
}

function renderDialog(initialProviderId: string | null): string {
  const theme = createTheme({
    components: { MuiDialog: { defaultProps: { disablePortal: true } } }
  })
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme },
      createElement(AddProviderDialog, {
        open: true,
        providers: [provider],
        initialProviderId,
        activePrompts: [],
        providerHint: '',
        isProcessing: false,
        onClose: () => undefined,
        onSelectProvider: () => undefined,
        onBackToList: () => undefined,
        onSubmitApiKey: async () => undefined,
        onStartOAuth: async () => undefined,
        onSubmitPrompt: async () => undefined,
        onUpdatePromptValue: () => undefined
      })
    )
  )
}

test('provider dialog renders the requested provider configuration immediately', () => {
  const markup = renderDialog(provider.providerId)
  assert.match(markup, /Direct Provider/)
  assert.match(markup, /OAuth/)
  assert.match(markup, /API Key/)
})

test('provider dialog renders provider selection when no provider was requested', () => {
  const markup = renderDialog(null)
  assert.match(markup, /搜索 Provider/)
  assert.match(markup, /aria-label="Provider 列表"/)
  assert.match(markup, /Direct Provider/)
  assert.ok(markup.indexOf('Provider 列表') < markup.indexOf('关闭'))
  assert.doesNotMatch(markup, /OAuth 登录/)
})
