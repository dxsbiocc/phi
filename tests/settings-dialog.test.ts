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
    noProjectTaskFolder: '/Users/example/Documents/Codex',
    preventSleepDuringRuns: false,
    nextActionSuggestionsEnabled: true,
    isSavingAppSettings: false,
    onUpdateAppSettings: () => undefined,
    onPickNoProjectTaskFolder: () => undefined,
    environmentSnapshot: {
      scannedAt: '2026-01-01T00:00:00.000Z',
      firstScanCompleted: true,
      summaryDismissed: true,
      hostDependencies: [],
      hostTools: [],
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

test('settings dialog has a dedicated web search category', () => {
  const markup = renderSettingsDialog({ category: 'web-search' })

  assert.match(markup, /网页搜索/)
  assert.match(markup, /读取设置/)
  assert.doesNotMatch(markup, /尚未配置任何 Provider/)
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

test('settings dialog exposes developer extensions under advanced settings', () => {
  const markup = renderSettingsDialog({ category: 'advanced' })

  assert.match(markup, />高级</)
  assert.match(markup, /开发者扩展/)
  assert.match(markup, /Pi runtime/)
  assert.match(markup, /软件源/)
  assert.match(markup, /导入软件包…/)
  assert.match(markup, /添加目录/)
  assert.match(markup, /没有找到开发者扩展/)
  assert.doesNotMatch(markup, /没有找到插件/)
})

test('settings dialog exposes general application settings', () => {
  const markup = renderSettingsDialog({ category: 'general' })

  assert.match(markup, /通用/)
  assert.match(markup, /无项目任务文件夹/)
  assert.match(markup, /在项目外启动的任务默认存储数据的位置。/)
  assert.match(markup, /\/Users\/example\/Documents\/Codex/)
  assert.match(markup, /更改/)
  assert.match(markup, /运行任务时防止系统休眠/)
  assert.match(markup, /提示词建议/)
  assert.match(markup, /上下文压缩/)
  assert.match(markup, /自动压缩设置仅作用于当前会话/)
  assert.match(markup, /打开会话后可调整压缩设置/)
  assert.doesNotMatch(markup, /生物数据库工具/)
  assert.doesNotMatch(markup, /本地路径点击方式/)
  assert.doesNotMatch(markup, /添加 Provider/)
})

test('general settings shows current-session compaction controls', () => {
  const markup = renderSettingsDialog({
    category: 'general',
    autoCompactionTarget: {
      sessionPath: 'phi-session:session-a',
      phiSessionId: 'session-a',
      sessionGeneration: 0
    },
    onCompactContext: () => undefined
  })

  assert.match(markup, /正在读取自动压缩设置/)
  assert.match(markup, /aria-label="压缩当前会话上下文"/)
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
