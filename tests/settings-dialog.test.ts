import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import { DEFAULT_PROXY_TRANSPORT_STATUS } from '../src/shared/appSettingsTypes'
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
    defaultProxyMode: 'auto',
    noProjectTaskFolder: '/Users/example/Documents/Codex',
    preventSleepDuringRuns: false,
    nextActionSuggestionsEnabled: true,
    proxyTransportStatus: DEFAULT_PROXY_TRANSPORT_STATUS,
    isSavingDefaultProxyMode: false,
    isSavingAppSettings: false,
    onSelectDefaultProxyMode: () => undefined,
    onUpdateAppSettings: () => undefined,
    onPickNoProjectTaskFolder: () => undefined,
    environmentSnapshot: {
      scannedAt: '2026-01-01T00:00:00.000Z',
      firstScanCompleted: true,
      summaryDismissed: true,
      tools: [
        {
          id: 'nextflow',
          label: 'Nextflow',
          status: 'ready',
          source: 'detected',
          activePath: '/opt/nextflow',
          detectedPath: '/opt/nextflow',
          detectedVersion: '24.0.0'
        },
        {
          id: 'jupyter',
          label: 'Jupyter',
          status: 'missing',
          source: 'none'
        }
      ]
    },
    isLoadingEnvironment: false,
    isRedetectingEnvironment: false,
    onRedetectEnvironment: async () => undefined,
    onSetEnvironmentToolPath: async () => undefined,
    dbConnectors: [
      {
        id: 'entrez/ncbi',
        name: 'NCBI Entrez',
        protocolFamily: 'entrez',
        curationTier: 'curated',
        trustTier: 'bundled',
        enabledForQuery: true,
        installedAt: 'bundled',
        domainCount: 3,
        domains: [
          { id: 'gene', summary: 'Gene records' },
          { id: 'pubmed', summary: 'Literature records' },
          { id: 'clinvar', summary: 'Clinical variants' }
        ]
      }
    ],
    isLoadingDbConnectors: false,
    updatingDbConnectorId: null,
    onRefreshDbConnectors: async () => undefined,
    onSetDbConnectorEnabled: async () => undefined,
    themeMode: 'system',
    onSelectThemeMode: () => undefined,
    ...overrides
  }

  return renderToStaticMarkup(
    createElement(ThemeProvider, { theme }, createElement(SettingsDialog, props))
  )
}

test('settings dialog exposes environment toolchain detection', () => {
  const markup = renderSettingsDialog({ category: 'environment' })

  assert.match(markup, /环境/)
  assert.match(markup, /Nextflow/)
  assert.match(markup, /已就绪|重新检测/)
  assert.match(markup, /Jupyter/)
  assert.doesNotMatch(markup, /检测到：/)
})

test('settings dialog can open directly on provider configuration', () => {
  const markup = renderSettingsDialog({ category: 'providers' })

  assert.match(markup, /Provider/)
  assert.doesNotMatch(markup, /Provider 配置/)
  assert.match(markup, /aria-label="刷新状态"/)
  assert.match(markup, /aria-label="添加 Provider"/)
  assert.doesNotMatch(markup, />刷新状态<|>添加 Provider</)
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
  assert.doesNotMatch(markup, /aria-label="Moonshot \(Kimi API\) Auth 登录"/)
  assert.doesNotMatch(markup, /aria-label="DeepSeek Auth 登录"/)
  assert.equal((markup.match(/>登出<\/button>/g) ?? []).length, 2)
  assert.doesNotMatch(markup, /MuiAlert-root/)
})

test('settings dialog explains diagnostics as a privacy-safe support summary', () => {
  const markup = renderSettingsDialog({ category: 'diagnostics' })

  assert.match(markup, /复制支持摘要/)
  assert.match(markup, /密钥脱敏/)
  assert.match(markup, /不含聊天全文/)
  assert.match(markup, /不含工具完整输出/)
  assert.doesNotMatch(markup, /添加 Provider/)
})

test('settings dialog exposes default proxy mode in general settings', () => {
  const markup = renderSettingsDialog({ category: 'general', defaultProxyMode: 'enabled' })

  assert.match(markup, /通用/)
  assert.match(markup, /默认代理模式/)
  assert.match(markup, /自动选择/)
  assert.match(markup, /开启/)
  assert.match(markup, /关闭/)
  assert.match(markup, /type="radio"/)
  assert.match(markup, /受控代理通道/)
  assert.match(markup, /开启不可用/)
  assert.match(markup, /无项目任务文件夹/)
  assert.match(markup, /在项目外启动的任务默认存储数据的位置。/)
  assert.match(markup, /\/Users\/example\/Documents\/Codex/)
  assert.match(markup, /更改/)
  assert.match(markup, /运行任务时防止系统休眠/)
  assert.match(markup, /提示词建议/)
  assert.doesNotMatch(markup, /生物数据库工具/)
  assert.doesNotMatch(markup, /本地路径点击方式/)
  assert.doesNotMatch(markup, /添加 Provider/)
})

test('settings dialog exposes database connector toggles in database settings', () => {
  const markup = renderSettingsDialog({ category: 'databases' })

  assert.match(markup, /数据库/)
  assert.match(markup, /控制 Database agent 是否允许查询各个生物数据库/)
  assert.match(markup, /Database agent 始终可以发现已安装的数据库/)
  assert.match(markup, /关闭某个数据库后仍可查看说明，但不会执行查询/)
  assert.doesNotMatch(markup, /\bdb_(?:search|domain|docs_search|query)\b/)
  assert.match(markup, /NCBI Entrez/)
  assert.match(markup, /entrez\/ncbi/)
  assert.match(markup, /启用查询/)
  assert.match(markup, /type="checkbox"/)
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
