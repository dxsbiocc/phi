import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material/styles'
import MacWindowControls from '../src/renderer/src/components/MacWindowControls'
import WindowNavigationControls from '../src/renderer/src/components/WindowNavigationControls'
import AppSnackbarCard from '../src/renderer/src/components/AppSnackbarCard'
import { AppErrorBoundary } from '../src/renderer/src/components/AppErrorBoundary'
import {
  WorkspaceFilesPane,
  WorkspaceSidePanel
} from '../src/renderer/src/components/WorkspaceSidePanel'
import {
  FILE_TYPE_ICON_META,
  PHI_ICON_META,
  PERMISSION_MODE_ICON_META,
  TOOL_ACTION_ICON_META,
  fileIconForPath
} from '../src/renderer/src/icons'
import { getUiLanguage, setUiLanguage } from '../src/renderer/src/lib/i18n'
import { getProviderErrorDisplay } from '../src/renderer/src/lib/providerErrors'
import { projectLocationSummary, type Project } from '../src/renderer/src/lib/projectTypes'
import { workspaceScopeLabelForCwd } from '../src/renderer/src/lib/workspaceScope'

const render = (element: ReactElement): string =>
  renderToStaticMarkup(createElement(ThemeProvider, { theme: createTheme() }, element))

test.afterEach(() => setUiLanguage('en'))

test('window controls default to English and return to each language after import', () => {
  assert.equal(getUiLanguage(), 'en')
  for (const [language, close, minimize, full, sidebar, search] of [
    ['en', 'Close', 'Minimize', 'Full screen', 'Collapse sidebar', 'Find chats'],
    ['zh-CN', '关闭', '最小化', '全屏', '收起侧边栏', '查找会话'],
    ['en', 'Close', 'Minimize', 'Full screen', 'Collapse sidebar', 'Find chats']
  ] as const) {
    setUiLanguage(language)
    const window = render(
      createElement(MacWindowControls, {
        onClose: () => undefined,
        onMinimize: () => undefined,
        onToggleFullscreen: () => undefined
      })
    )
    for (const label of [close, minimize, full])
      assert.ok(window.includes(`aria-label="${label}"`), label)
    const navigation = render(
      createElement(WindowNavigationControls, {
        isSidebarOpen: true,
        onToggleSidebar: () => undefined,
        onOpenSessionSearch: () => undefined
      })
    )
    for (const label of [sidebar, search])
      assert.ok(navigation.includes(`aria-label="${label}"`), label)
    assert.match(navigation, /data-phi-window-sidebar-toggle-icon="collapse"/)
  }
})

test('saved icon metadata reads current labels without changing artwork, type or colors', () => {
  const action = PHI_ICON_META['action.copy']
  const file = FILE_TYPE_ICON_META.python
  const resolvedFile = fileIconForPath('/项目/analysis.py')
  const originalIcon = file.Icon
  const originalResolvedIcon = resolvedFile.Icon
  for (const [language, copy, python, ask, read] of [
    ['en', 'Copy', 'Python file', 'Ask', 'Read file'],
    ['zh-CN', '复制', 'Python 文件', '询问', '读取文件'],
    ['en', 'Copy', 'Python file', 'Ask', 'Read file']
  ] as const) {
    setUiLanguage(language)
    assert.equal(action.label, copy)
    assert.equal(file.label, python)
    assert.equal(resolvedFile.label, python)
    assert.equal(PERMISSION_MODE_ICON_META.ask.label, ask)
    assert.equal(TOOL_ACTION_ICON_META.read.label, read)
    assert.equal(file.Icon, originalIcon)
    assert.equal(resolvedFile.Icon, originalResolvedIcon)
    assert.equal(file.kind, 'python')
    assert.equal(file.color, '#3776AB')
  }
})

test('provider guidance changes language while classification and redacted evidence stay stable', () => {
  const cases = [
    ['402 insufficient balance', 'Insufficient account balance', '账户余额不足'],
    ['429 rate_limit api_key=secret123456', 'Too many requests', '请求太频繁'],
    [
      '401 invalid authentication',
      'Invalid API key or authentication failed',
      'API Key 无效或认证失败'
    ],
    ['没有配置 Provider 或可用模型', 'Provider needs attention', 'Provider 需要处理'],
    [
      'AI 没有生成可插入内容。返回片段: 原始内容',
      'No notebook cell to insert',
      '没有可插入的 notebook cell'
    ],
    [
      'Cursor run transport could not negotiate HTTP/2',
      'Cursor HTTP/2 connection failed',
      'Cursor HTTP/2 连接失败'
    ],
    [
      'ERROR_RATE_LIMITED_CHANGEABLE {"isRetryable":false}',
      'Cursor usage limit reached',
      'Cursor 用量上限已用尽'
    ],
    ['connection interrupted', 'Request failed', '请求失败']
  ] as const
  for (const [raw, english, chinese] of cases) {
    setUiLanguage('en')
    const first = getProviderErrorDisplay(raw)
    assert.equal(first.title, english)
    setUiLanguage('zh-CN')
    const second = getProviderErrorDisplay(raw)
    assert.equal(second.title, chinese)
    assert.equal(second.rawMessage, first.rawMessage)
    assert.equal(second.action, first.action)
    assert.equal(second.showRawMessage, first.showRawMessage)
    assert.doesNotMatch(second.rawMessage, /secret123456/)
  }
})

test('notices and crash recovery translate only the shell around user and diagnostic content', () => {
  const boundary = new AppErrorBoundary({ children: 'chat' })
  boundary.state = {
    error: new Error('原始错误: Unmodified diagnostic'),
    componentStack: 'at ProjectChat (/workspace/project.tsx:10)'
  }
  for (const [language, close, severity, title, retry] of [
    [
      'en',
      'Close notification',
      'Warning',
      'The interface encountered an error',
      'Retry rendering'
    ],
    ['zh-CN', '关闭通知', '警告', '界面渲染遇到错误', '重试渲染']
  ] as const) {
    setUiLanguage(language)
    const notice = render(
      createElement(AppSnackbarCard, {
        notice: { id: 1, severity: 'warning', message: '作者的原始消息' },
        onClose: () => undefined
      })
    )
    assert.ok(notice.includes(`aria-label="${close}"`))
    assert.ok(notice.includes(`aria-label="${severity}"`))
    assert.ok(notice.includes('作者的原始消息'))
    const error = renderToStaticMarkup(boundary.render() as ReactElement)
    for (const text of [
      title,
      retry,
      '原始错误: Unmodified diagnostic',
      '/workspace/project.tsx:10'
    ])
      assert.ok(error.includes(text), text)
  }
})

test('panel labels and project summaries translate without changing selected slots or user names', () => {
  const project: Project = {
    id: 'project-a',
    name: '作者项目',
    location: {
      kind: 'ssh',
      hostProfileId: 'cluster',
      remoteRoot: '/数据/project',
      canonicalRoot: '/数据/project'
    },
    workingDirectory: '/数据/project',
    permissionMode: 'ask',
    remoteHostAlias: '作者服务器',
    remoteReachability: 'offline',
    createdAt: '2026-10-18T00:00:00Z'
  }
  const before = structuredClone(project)
  for (const [language, jobs, close, empty, general, offline] of [
    [
      'en',
      'Background Jobs',
      'Close Background Jobs',
      'No workspace yet',
      'General',
      'Server offline'
    ],
    ['zh-CN', '后台任务', '关闭后台任务', '还没有工作空间', '普通', '服务器离线']
  ] as const) {
    setUiLanguage(language)
    const panel = render(
      createElement(WorkspaceSidePanel, {
        width: 400,
        slots: ['jobs', 'terminal'],
        maximized: null,
        onCloseSlot: () => undefined,
        onToggleMaximized: () => undefined,
        renderSlot: () => '用户面板内容'
      })
    )
    assert.ok(panel.includes(`aria-label="${jobs}"`))
    assert.ok(panel.includes(`aria-label="${close}"`))
    assert.match(panel, /data-phi-workspace-side-panel-modes="jobs,terminal"/)
    assert.ok(panel.includes('用户面板内容'))
    assert.ok(render(createElement(WorkspaceFilesPane, { treeRevision: 0 })).includes(empty))
    assert.equal(workspaceScopeLabelForCwd('/other', [project]), general)
    assert.equal(projectLocationSummary(project), `作者服务器 · /数据/project · ${offline}`)
    assert.equal(
      workspaceScopeLabelForCwd('/local', [{ name: '作者项目', workingDirectory: '/local' }]),
      '作者项目'
    )
    assert.deepEqual(project, before)
  }
})
