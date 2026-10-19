import { setUiLanguage } from '../src/renderer/src/lib/i18n'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import { HomeView } from '../src/renderer/src/features/home/HomeView'
import { HomeOverviewCards } from '../src/renderer/src/features/home/components/HomeOverviewCards'
import { HomeResourceCategoryIcon } from '../src/renderer/src/features/home/components/HomeResourceCategoryIcon'
import { HomePeriodSummary } from '../src/renderer/src/features/home/components/HomePeriodSummary'
import {
  rankHomeWrapperRuns,
  selectHomeRecentWork
} from '../src/renderer/src/features/home/lib/homeOverview'
import type { Project, SessionSummary } from '../src/renderer/src/types'
import type { WrapperRun } from '../src/shared/wrapperTypes'

const project: Project = {
  id: 'project-1',
  name: '示例项目',
  location: { kind: 'local', path: '/example', realPath: '/example' },
  workingDirectory: '/example',
  permissionMode: 'ask',
  createdAt: '2026-10-01T00:00:00.000Z'
}

function session(path: string, status: SessionSummary['status'] = 'idle'): SessionSummary {
  return {
    path,
    id: path,
    created: '2026-10-01T00:00:00.000Z',
    modified: '2026-10-02T00:00:00.000Z',
    messageCount: 4,
    firstMessage: `继续 ${path}`,
    status,
    unreadKind: null
  }
}

function renderHomeView(): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(HomeView, {
        sessions: [session('/ordinary')],
        sessionsLoading: false,
        projects: [project],
        projectSessionRefreshKey: 0,
        onFetchProjectSessions: async () => [],
        resources: {
          skills: { total: 9, active: 7, icons: [{ key: 'skill-logo' }] },
          wrappers: { total: 4, active: 3 },
          connectors: { total: 5, active: 2 },
          plugins: { total: 2, active: 1 }
        },
        wrapperRuns: [],
        wrapperCatalog: [],
        lastClosedSessionPath: null,
        onLoadResources: async () => undefined,
        onNewChat: () => undefined,
        onShowProjects: () => undefined,
        onOpenSession: () => undefined
      })
    )
  )
}

// Keep the existing Chinese behavior assertions explicit; English switching has dedicated coverage.
setUiLanguage('zh-CN')

test('home dashboard prioritizes resumable work and groups resource-owned icons', () => {
  const markup = renderHomeView()

  assert.match(markup, /继续你的工作/)
  assert.doesNotMatch(markup, /从上次停下的地方接着做/)
  const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
  assert.match(appSource, /const showHomeWorkspace =/)
  assert.match(appSource, /hideTitle=\{showHomeWorkspace\}/)
  assert.match(
    readFileSync(
      resolve(process.cwd(), 'src/renderer/src/features/workspace/WorkspaceView.tsx'),
      'utf8'
    ),
    /\{hideTitle \? null : \(/
  )

  assert.match(markup, /data-phi-home-primary-card="true"/)
  assert.match(markup, /继续最近的工作/)
  assert.match(markup, /继续 \/ordinary/)
  assert.match(markup, /1 条普通对话/)
  assert.doesNotMatch(markup, /最近项目|项目与对话/)
  assert.match(markup, /data-phi-home-resource="skills"/)
  assert.match(markup, /data-phi-home-resource="wrappers"/)
  assert.match(markup, /data-phi-home-resource="connectors"/)
  assert.match(markup, /data-phi-home-resource="plugins"/)
  assert.match(markup, /data-phi-home-resource-icon="skill"/)
  assert.match(markup, /data-phi-resource-icon-key="skill-logo"/)
  assert.match(markup, /data-phi-home-session-status="true"/)
  assert.ok(
    markup.indexOf('data-phi-home-primary-card') < markup.indexOf('data-phi-home-resources-card')
  )
  assert.match(markup, /data-phi-home-wrapper-ranking="true"/)
  assert.ok(markup.indexOf('过去一年的活跃度') < markup.indexOf('data-phi-home-primary-card'))
  assert.match(markup, /开始一次 Wrapper 任务后会显示排行/)
  assert.doesNotMatch(markup, /工作总览|每个方格代表一天，深色表示更多运行次数与任务历时/)

  const source = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/features/home/components/HomeOverviewCards.tsx'),
    'utf8'
  )
  assert.doesNotMatch(source, /PhiIcons\.nav\.(skills|wrappers|mcp|plugins)/)
  assert.match(source, /gridTemplateColumns: 'minmax\(0, 1fr\) 5em'/)
  assert.match(source, /gridTemplateColumns: 'minmax\(0, 1fr\) 5em',[\s\S]*?alignItems: 'center'/)
  assert.match(source, /textAlign: 'right'/)
  assert.match(source, /width: 88/)
  assert.match(source, /alignSelf: 'center'/)
  assert.match(
    source,
    /data-phi-home-session-content="true"[\s\S]*?<\/Box>\s*<Chip[\s\S]*?data-phi-home-session-status="true"/
  )
  assert.match(source, /justifyContent: 'space-between'/)
})

function renderOverview(overrides: Partial<Parameters<typeof HomeOverviewCards>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(HomeOverviewCards, {
        projectCount: 0,
        ordinaryConversationCount: 0,
        projectConversationCount: 0,
        projectConversationsLoading: false,
        projectConversationsIncomplete: false,
        runningCount: 0,
        attentionCount: 0,
        recentWork: [],
        resources: {
          skills: { total: 0, active: 0 },
          wrappers: { total: 0, active: 0 },
          connectors: { total: 0, active: 0 },
          plugins: { total: 0, active: 0 }
        },
        wrapperRanking: [],
        wrapperRunCount: 0,
        onOpenSession: () => undefined,
        ...overrides
      })
    )
  )
}

test('empty conversations retain the continuation card and show an empty state', () => {
  const markup = renderOverview()

  assert.match(markup, /data-phi-home-primary-card="true"/)
  assert.match(markup, /data-phi-home-recent-state="empty"/)
  assert.match(markup, /暂无可继续的对话/)
  assert.match(markup, /data-phi-home-resources-card="true"/)
})

test('loading ordinary conversations reserves four Skeleton rows instead of an empty state', () => {
  const markup = renderOverview({ sessionsLoading: true })

  assert.match(markup, /data-phi-home-recent-state="loading" aria-busy="true"/)
  assert.equal((markup.match(/data-phi-home-session-skeleton="true"/g) ?? []).length, 4)
  assert.doesNotMatch(markup, /暂无可继续的对话/)
})

test('project conversation loading preserves known work and fills only the remaining slots', () => {
  const markup = renderOverview({
    ordinaryConversationCount: 1,
    projectConversationsLoading: true,
    recentWork: [{ session: session('/ordinary'), project: null }]
  })

  assert.match(markup, /继续 \/ordinary/)
  assert.equal((markup.match(/data-phi-home-session-skeleton="true"/g) ?? []).length, 3)
  assert.doesNotMatch(markup, /暂无可继续的对话/)
})

test('failed project conversation reads retain both cards and explain the unavailable data', () => {
  const markup = renderOverview({ projectCount: 1, projectConversationsIncomplete: true })

  assert.match(markup, /data-phi-home-primary-card="true"/)
  assert.match(markup, /项目对话暂不可用/)
  assert.match(markup, /data-phi-home-resources-card="true"/)
  assert.doesNotMatch(markup, /data-phi-home-session-skeleton/)
})

test('resource counts show Skeletons while loading instead of reporting zero', () => {
  const markup = renderOverview({
    resources: {
      skills: { total: 0, active: 0, loading: true },
      wrappers: { total: 0, active: 0, loading: true },
      connectors: { total: 0, active: 0, loading: true },
      plugins: { total: 0, active: 0, loading: true }
    }
  })

  assert.equal((markup.match(/data-phi-home-resource-loading="true"/g) ?? []).length, 4)
  assert.doesNotMatch(markup, /共 0 个/)
})

test('activity placeholders keep period labels and end when no data is available', () => {
  const render = (loading: boolean): string =>
    renderToStaticMarkup(
      createElement(
        ThemeProvider,
        { theme: createTheme() },
        createElement(HomePeriodSummary, { activity: null, loading })
      )
    )

  const pending = render(true)
  for (const label of ['本周', '本月', '今年']) assert.match(pending, new RegExp(label))
  assert.match(pending, /MuiSkeleton-root/)

  const unavailable = render(false)
  assert.match(unavailable, /暂无活动记录/)
  assert.doesNotMatch(unavailable, /MuiSkeleton-root/)
})

test('Wrapper and plugin fallbacks render substantial filled category icons', () => {
  for (const kind of ['wrapper', 'plugin'] as const) {
    const markup = renderToStaticMarkup(createElement(HomeResourceCategoryIcon, { kind }))
    assert.match(markup, /width="32" height="32"/)
    assert.match(markup, /fill="currentColor"/)
  }
})

test('project conversations appear in the same continuation list and attention takes priority', () => {
  const ordinary = session('/ordinary')
  const projectSession = session('/project-session', 'needs_approval')
  const recent = selectHomeRecentWork(
    [ordinary],
    [{ session: projectSession, project }],
    '/ordinary'
  )

  assert.deepEqual(
    recent.map(({ session, project }) => [session.path, project?.name ?? '普通对话']),
    [
      ['/project-session', '示例项目'],
      ['/ordinary', '普通对话']
    ]
  )
})

function wrapperRun(runId: string, canonicalId: string, shortId: string): WrapperRun {
  return {
    runId,
    planId: '',
    revision: 1,
    state: 'completed',
    actor: 'user',
    wrapper: { canonicalId, namespace: 'phi', shortId, version: '1.0.0' },
    trustTier: 'custom',
    executor: 'local',
    profile: 'local',
    cwd: '/example',
    outDir: 'results',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:01:00.000Z'
  }
}

test('Wrapper ranking uses persisted run records instead of inventory size', () => {
  const ranking = rankHomeWrapperRuns(
    [
      wrapperRun('run-1', 'phi/align', 'align'),
      wrapperRun('run-2', 'phi/count', 'count'),
      wrapperRun('run-3', 'phi/align', 'align')
    ],
    []
  )

  assert.deepEqual(ranking, [
    { id: 'phi/align', name: 'align', count: 2 },
    { id: 'phi/count', name: 'count', count: 1 }
  ])
})
