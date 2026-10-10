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
        onLoadResources: () => undefined,
        onNewChat: () => undefined,
        onShowProjects: () => undefined,
        onOpenSession: () => undefined
      })
    )
  )
}

test('home dashboard prioritizes resumable work and groups resource-owned icons', () => {
  const markup = renderHomeView()

  assert.match(markup, /继续你的工作/)
  assert.doesNotMatch(markup, /从上次停下的地方接着做/)
  const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
  assert.match(appSource, /const showHomeWorkspace =/)
  assert.match(appSource, /\{!showHomeWorkspace \? \(/)

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
  assert.match(markup, /暂无运行记录/)
  assert.doesNotMatch(markup, /工作总览|每个方格代表一天，深色表示更多运行次数与任务历时/)

  const source = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/features/home/components/HomeOverviewCards.tsx'),
    'utf8'
  )
  assert.doesNotMatch(source, /PhiIcons\.nav\.(skills|wrappers|mcp|plugins)/)
  assert.match(source, /gridTemplateColumns: 'minmax\(0, 1fr\) 3em'/)
  assert.match(source, /gridTemplateColumns: 'minmax\(0, 1fr\) 3em',[\s\S]*?alignItems: 'center'/)
  assert.match(source, /textAlign: 'right'/)
  assert.match(source, /width: 88/)
  assert.match(source, /alignSelf: 'center'/)
  assert.match(
    source,
    /data-phi-home-session-content="true"[\s\S]*?<\/Box>\s*<Chip[\s\S]*?data-phi-home-session-status="true"/
  )
  assert.match(source, /justifyContent: 'space-between'/)
})

test('empty conversation state omits the large continuation card', () => {
  const markup = renderToStaticMarkup(
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
        onOpenSession: () => undefined
      })
    )
  )

  assert.doesNotMatch(markup, /data-phi-home-primary-card/)
  assert.match(markup, /data-phi-home-resources-card="true"/)
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
