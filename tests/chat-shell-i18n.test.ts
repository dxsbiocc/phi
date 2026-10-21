import { createTheme, ThemeProvider } from '@mui/material/styles'
import { ComposerReferenceChip } from '../src/renderer/src/components/chat/ComposerReferenceChip'
import { HomeOverviewCards } from '../src/renderer/src/features/home/components/HomeOverviewCards'
import {
  ModelSelectorControl,
  PermissionModeControl
} from '../src/renderer/src/components/chat/ChatComposerControls'
import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { setUiLanguage } from '../src/renderer/src/lib/i18n'
import { chatCopy } from '../src/renderer/src/features/chat/lib/chatCopy'
import { chatEnglish } from '../src/renderer/src/features/chat/lib/chatCopy.en'
import { chatChinese } from '../src/renderer/src/features/chat/lib/chatCopy.zh-CN'
import { navigationCopy } from '../src/renderer/src/lib/navigationCopy'
import { homeCopy } from '../src/renderer/src/features/home/lib/homeCopy'
import { jobsCopy } from '../src/renderer/src/features/jobs/lib/jobsCopy'
import { projectCopy } from '../src/renderer/src/features/project/lib/projectCopy'
import { agentCopy } from '../src/renderer/src/features/agent/lib/agentCopy'
import { connectorJobCopy } from '../src/renderer/src/features/jobs/lib/connectorJobCopy'
import { sessionDisplayTitle } from '../src/renderer/src/lib/sessionTitles'
import { todoStatusLabel } from '../src/renderer/src/lib/todoPanel'
import {
  workspaceResourceKindLabel,
  workspaceTabKindLabel
} from '../src/renderer/src/lib/workspaceResourceTabs'
import { contextUsagePresentation } from '../src/renderer/src/features/chat/lib/contextUsagePresentation'
import {
  formatActivityDuration,
  buildHomeActivityCalendar
} from '../src/renderer/src/features/home/lib/homeActivity'
import { notebookVerb } from '../src/renderer/src/components/tool-call/notebookToolSummaryModel'
import ToolApprovalDialog from '../src/renderer/src/components/ToolApprovalDialog'
import ToolGroupCard from '../src/renderer/src/components/ToolGroupCard'
import { WorkspaceResourceTabs } from '../src/renderer/src/components/WorkspaceResourceTabs'
import { ProjectLocationFields } from '../src/renderer/src/features/project/components/ProjectLocationFields'
import type { SessionSummary, ToolCallItem } from '../src/renderer/src/types'

const text = (markup: string): string =>
  markup
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]*>/g, '')
    .replaceAll('<!-- -->', '')
afterEach(() => setUiLanguage('en'))

test('chat dictionaries provide matching semantic keys and English source copy', () => {
  assert.deepEqual(Object.keys(chatEnglish), Object.keys(chatChinese))
  for (const value of Object.values(chatEnglish)) {
    const formatted =
      typeof value === 'function' ? Reflect.apply(value, undefined, ['sample', 2, 3]) : value
    assert.doesNotMatch(formatted, /\p{Script=Han}/u)
  }
})

test('saved copy references and static label maps resolve the current language', () => {
  const copies = [
    chatCopy,
    navigationCopy,
    homeCopy,
    jobsCopy,
    projectCopy,
    agentCopy,
    connectorJobCopy
  ]
  setUiLanguage('en')
  assert.equal(chatCopy.sendMessage, 'Send message')
  assert.equal(todoStatusLabel('blocked'), 'Blocked')
  assert.equal(workspaceResourceKindLabel('mcp'), 'Connectors')
  assert.equal(workspaceTabKindLabel('plugins'), 'Plugins')
  assert.equal(connectorJobCopy.completedTools(2), 'Completed · 2 tools')
  setUiLanguage('zh-CN')
  assert.equal(chatCopy.sendMessage, '发送消息')
  assert.equal(todoStatusLabel('blocked'), '已阻塞')
  assert.equal(workspaceResourceKindLabel('mcp'), '连接器')
  assert.equal(workspaceTabKindLabel('plugins'), '插件')
  assert.equal(connectorJobCopy.completedTools(2), '已完成 · 2 个工具')
  assert.deepEqual(copies, [
    chatCopy,
    navigationCopy,
    homeCopy,
    jobsCopy,
    projectCopy,
    agentCopy,
    connectorJobCopy
  ])
})

test('fallback conversation titles switch while user-authored titles remain intact', () => {
  const session = { name: '', firstMessage: '' } as SessionSummary
  setUiLanguage('en')
  assert.equal(sessionDisplayTitle(session), 'New conversation')
  assert.equal(sessionDisplayTitle({ ...session, name: '实验报告' }), '实验报告')
  setUiLanguage('zh-CN')
  assert.equal(sessionDisplayTitle(session), '新对话')
  assert.equal(sessionDisplayTitle({ ...session, name: '实验报告' }), '实验报告')
})

test('context and notebook action labels switch without changing protocol values', () => {
  setUiLanguage('en')
  assert.equal(contextUsagePresentation(null, true).label, 'Loading context…')
  assert.equal(notebookVerb('notebook_document', 'done'), 'Notebook read')
  setUiLanguage('zh-CN')
  assert.equal(contextUsagePresentation(null, true).label, '正在读取上下文…')
  assert.equal(notebookVerb('notebook_document', 'done'), '已读取 Notebook')
})

test('approval actions translate while command and workspace evidence stay original', () => {
  const props = {
    request: {
      requestId: 'approval-1',
      toolName: 'bash',
      summary: 'echo "原始命令"',
      sessionPath: 'phi-session:one'
    },
    onRespond: () => undefined,
    onOpenSession: () => undefined
  }
  setUiLanguage('en')
  const english = text(renderToStaticMarkup(createElement(ToolApprovalDialog, props)))
  assert.match(english, /Execute terminal command/)
  assert.match(english, /Approve/)
  assert.match(english, /原始命令/)
  setUiLanguage('zh-CN')
  const chinese = text(renderToStaticMarkup(createElement(ToolApprovalDialog, props)))
  assert.match(chinese, /执行终端命令/)
  assert.match(chinese, /批准/)
  assert.match(chinese, /原始命令/)
})

test('tool summaries re-evaluate localized labels with the same tool items', () => {
  const items: ToolCallItem[] = [
    {
      id: 'tool-one',
      role: 'tool',
      toolName: 'bash',
      argsPreview: 'echo sample',
      argsJson: '{"command":"echo sample"}',
      output: '',
      status: 'done'
    }
  ]
  setUiLanguage('en')
  assert.match(
    text(renderToStaticMarkup(createElement(ToolGroupCard, { items }))),
    /Command executed/
  )
  setUiLanguage('zh-CN')
  assert.match(text(renderToStaticMarkup(createElement(ToolGroupCard, { items }))), /已执行命令/)
  assert.equal(items[0].argsPreview, 'echo sample')
})

test('installed Plugins tab localizes without renaming author-owned tabs', () => {
  const props = {
    tabs: [
      { key: 'plugins', kind: 'plugins' as const, itemId: 'installed', title: 'Plugins' },
      { key: 'skills', kind: 'skills' as const, itemId: 'author-skill', title: '作者提供的名称' }
    ],
    activeKey: 'plugins',
    onSelect: () => undefined,
    onClose: () => undefined
  }
  setUiLanguage('zh-CN')
  const chinese = renderToStaticMarkup(createElement(WorkspaceResourceTabs, props))
  assert.match(chinese, /title="插件"/)
  assert.match(chinese, /作者提供的名称/)
  setUiLanguage('en')
  const english = renderToStaticMarkup(createElement(WorkspaceResourceTabs, props))
  assert.match(english, /title="Plugins"/)
  assert.match(english, /作者提供的名称/)
})

test('project controls translate while keeping the same directory value and mode', () => {
  const props = {
    mode: 'local' as const,
    workingDirectory: '/work/实验',
    onModeChange: () => undefined,
    onPickDirectory: () => undefined,
    hosts: [],
    hostsLoading: false,
    hostsError: null,
    hostProfileId: '',
    remoteRoot: '',
    onHostChange: () => undefined,
    onRemoteRootChange: () => undefined,
    onOpenRemoteSettings: () => undefined
  }
  setUiLanguage('en')
  const english = renderToStaticMarkup(createElement(ProjectLocationFields, props))
  assert.match(english, /Local folder/)
  assert.match(english, /value="\/work\/实验"/)
  setUiLanguage('zh-CN')
  const chinese = renderToStaticMarkup(createElement(ProjectLocationFields, props))
  assert.match(chinese, /本机文件夹/)
  assert.match(chinese, /value="\/work\/实验"/)
})

test('activity dates and elapsed durations use the selected display locale', () => {
  const today = new Date(2026, 9, 18)
  setUiLanguage('en')
  assert.equal(formatActivityDuration(90 * 60_000), '1 h 30 min')
  const english = buildHomeActivityCalendar([], today).at(-1)?.days[0]?.label
  assert.match(english ?? '', /October/)
  setUiLanguage('zh-CN')
  assert.equal(formatActivityDuration(90 * 60_000), '1 小时 30 分')
  const chinese = buildHomeActivityCalendar([], today).at(-1)?.days[0]?.label
  assert.match(chinese ?? '', /10月/)
})

test('permission and thinking controls translate labels while preserving enum selections', () => {
  const permission = {
    permissionMode: 'auto' as const,
    disabled: false,
    onSelectPermissionMode: () => undefined
  }
  const model = {
    providerId: 'openai',
    modelId: 'gpt',
    name: 'GPT',
    thinkingLevels: ['low', 'high'] as Array<'low' | 'high'>
  }
  const thinking = {
    models: [model],
    selectedModel: model,
    onSelectModel: () => undefined,
    thinkingLevel: 'high' as const,
    supportedThinkingLevels: ['low', 'high'] as Array<'low' | 'high'>,
    onSelectThinkingLevel: () => undefined
  }
  setUiLanguage('en')
  assert.match(
    text(renderToStaticMarkup(createElement(PermissionModeControl, permission))),
    /Permissions Auto/
  )
  assert.match(text(renderToStaticMarkup(createElement(ModelSelectorControl, thinking))), /High/)
  setUiLanguage('zh-CN')
  assert.match(
    text(renderToStaticMarkup(createElement(PermissionModeControl, permission))),
    /权限 自动/
  )
  assert.match(text(renderToStaticMarkup(createElement(ModelSelectorControl, thinking))), /高/)
  assert.equal(permission.permissionMode, 'auto')
  assert.equal(thinking.thinkingLevel, 'high')
})

test('Notebook reference chip palette IDs stay invariant across interface languages', () => {
  const theme = createTheme({
    palette: {
      secondary: { main: '#abcdef' },
      primary: { main: '#123456' },
      info: { main: '#102030' },
      warning: { main: '#234567' },
      success: { main: '#345678' }
    }
  })
  const cases = [
    ['module', '171, 205, 239'],
    ['variable', '18, 52, 86'],
    ['dataframe', '16, 32, 48'],
    ['data_source', '35, 69, 103'],
    ['cell_output', '52, 86, 120']
  ] as const
  for (const [kind, rgb] of cases) {
    const styles: string[] = []
    for (const language of ['en', 'zh-CN'] as const) {
      setUiLanguage(language)
      const markup = renderToStaticMarkup(
        createElement(
          ThemeProvider,
          { theme },
          createElement(ComposerReferenceChip, {
            reference: { kind, name: 'context', text: '@context' },
            onRemove: () => undefined
          })
        )
      )
      assert.ok(
        markup.includes(`background-color:rgba(${rgb}, 0.1)`),
        `${language} ${kind} must keep its semantic palette color`
      )
      styles.push(
        [...markup.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((match) => match[1]).join('\n')
      )
    }
    assert.equal(styles[0], styles[1], `${kind} styles must not depend on translated labels`)
  }
})

test('Home resource headings and availability labels update after their module was imported', () => {
  const props = {
    projectCount: 0,
    ordinaryConversationCount: 0,
    projectConversationCount: 0,
    projectConversationsLoading: false,
    projectConversationsIncomplete: false,
    runningCount: 0,
    attentionCount: 0,
    recentWork: [],
    resources: {
      skills: { total: 1, active: 1 },
      wrappers: { total: 1, active: 1 },
      connectors: { total: 1, active: 1 },
      plugins: { total: 1, active: 1 }
    },
    wrapperRanking: [],
    wrapperRunCount: 0,
    onOpenSession: () => undefined
  }
  setUiLanguage('en')
  const english = text(renderToStaticMarkup(createElement(HomeOverviewCards, props)))
  for (const label of ['Skills', 'Wrappers', 'Connectors', 'Plugins', 'Enabled', 'Available'])
    assert.ok(english.includes(label), label)
  setUiLanguage('zh-CN')
  const chinese = text(renderToStaticMarkup(createElement(HomeOverviewCards, props)))
  for (const label of ['技能', '连接器', '插件', '启用', '可用'])
    assert.ok(chinese.includes(label), label)
  assert.doesNotMatch(chinese, /Skills|Connectors|Plugins|Enabled|Available/)
})
