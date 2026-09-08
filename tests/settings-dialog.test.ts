import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import SettingsDialog from '../src/renderer/src/components/SettingsDialog'
import type { ProviderAuthStatus } from '../src/renderer/src/types'

const provider: ProviderAuthStatus = {
  providerId: 'openai',
  name: 'OpenAI',
  configured: false,
  hasApiKey: true,
  hasOAuth: true,
  hasConfigError: false,
  statusText: '未配置'
}

test('settings dialog can open directly on provider configuration', () => {
  const theme = createTheme({
    components: { MuiDialog: { defaultProps: { disablePortal: true } } }
  })
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme },
      createElement(SettingsDialog, {
        open: true,
        category: 'providers',
        onCategoryChange: () => undefined,
        onClose: () => undefined,
        providers: [provider],
        providerHints: {},
        personaMarkdown: null,
        onSavePersonaMarkdown: async () => undefined,
        onRefresh: async () => undefined,
        onOpenAddProvider: () => undefined,
        onLogout: () => undefined,
        projects: [],
        models: [],
        pendingApproval: null,
        updatingProjectId: null,
        onUpdateProjectPermissionMode: () => undefined,
        onUpdateProjectDefaults: () => undefined,
        onOpenApprovalSession: () => undefined,
        onRespondApproval: () => undefined,
        onCopyDiagnostics: async () => '',
        themeMode: 'system',
        onSelectThemeMode: () => undefined
      })
    )
  )

  assert.match(markup, /Provider 配置/)
  assert.match(markup, /添加 Provider/)
  assert.doesNotMatch(markup, /以 Markdown 形式描述助手/)
})
