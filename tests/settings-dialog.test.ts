import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import SettingsDialog from '../src/renderer/src/components/SettingsDialog'
import type { ModelOption, Project, ProviderAuthStatus } from '../src/renderer/src/types'

const provider: ProviderAuthStatus = {
  providerId: 'openai',
  name: 'OpenAI',
  configured: false,
  hasApiKey: true,
  hasOAuth: true,
  hasConfigError: false,
  statusText: '未配置'
}

type SettingsDialogProps = Parameters<typeof SettingsDialog>[0]

function renderSettingsDialog(overrides: Partial<SettingsDialogProps> = {}): string {
  const theme = createTheme({
    components: { MuiDialog: { defaultProps: { disablePortal: true } } }
  })
  const props: SettingsDialogProps = {
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
    onSelectThemeMode: () => undefined,
    ...overrides
  }

  return renderToStaticMarkup(
    createElement(ThemeProvider, { theme }, createElement(SettingsDialog, props))
  )
}

test('settings dialog can open directly on provider configuration', () => {
  const markup = renderSettingsDialog({ category: 'providers' })

  assert.match(markup, /Provider 配置/)
  assert.match(markup, /添加 Provider/)
  assert.doesNotMatch(markup, /以 Markdown 形式描述助手/)
})

test('settings dialog keeps configured provider rows information-dense', () => {
  const markup = renderSettingsDialog({
    category: 'providers',
    providers: [
      {
        ...provider,
        providerId: 'deepseek',
        name: 'DeepSeek',
        configured: true,
        hasOAuth: false,
        statusText: 'stored'
      },
      {
        ...provider,
        providerId: 'moonshot',
        name: 'Moonshot (Kimi API)',
        configured: true,
        statusText: 'stored'
      }
    ]
  })

  assert.match(markup, /DeepSeek/)
  assert.match(markup, /deepseek/)
  assert.match(markup, /Moonshot \(Kimi API\)/)
  assert.match(markup, /moonshot/)
  assert.match(markup, /API Key/)
  assert.match(markup, /已配置/)
  assert.match(markup, /登出/)
})

test('settings dialog explains diagnostics as a privacy-safe support summary', () => {
  const markup = renderSettingsDialog({ category: 'diagnostics' })

  assert.match(markup, /复制支持摘要/)
  assert.match(markup, /密钥脱敏/)
  assert.match(markup, /不含聊天全文/)
  assert.match(markup, /不含工具完整输出/)
  assert.doesNotMatch(markup, /添加 Provider/)
})

test('settings dialog renders project permission controls without hiding defaults', () => {
  const project: Project = {
    id: 'project-1',
    name: 'test',
    workingDirectory: '/Users/dengxsh/Downloads/Work/App/Phi',
    permissionMode: 'full',
    createdAt: '2026-09-06T00:00:00.000Z'
  }
  const model: ModelOption = {
    providerId: 'openai',
    modelId: 'gpt-test',
    name: 'GPT Test',
    thinkingLevels: ['high']
  }
  const markup = renderSettingsDialog({
    category: 'permissions',
    projects: [project],
    models: [model]
  })

  assert.match(markup, /项目权限/)
  assert.match(markup, /安全策略/)
  assert.match(markup, /默认模型/)
  assert.match(markup, /思考等级/)
  assert.match(markup, /放宽项目工具限制/)
  assert.match(markup, /\/Users\/dengxsh\/Downloads\/Work\/App\/Phi/)
})
