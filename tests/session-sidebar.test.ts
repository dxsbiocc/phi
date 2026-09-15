import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import SessionSidebar from '../src/renderer/src/components/SessionSidebar'
import {
  activeCwdBelongsToProject,
  expandActiveProjectId,
  orderProjectsForSessionSelection,
  resolveProjectExpandedIds
} from '../src/renderer/src/lib/projectSidebar'
import {
  sessionBeaconKind,
  sessionRunningBeaconSlotWidth
} from '../src/renderer/src/lib/sessionBeacon'
import {
  isSessionListSortedByActivityTime,
  orderSessionsForDisplay,
  preserveSessionListOrder
} from '../src/renderer/src/lib/sessionOrder'
import type { SessionRuntimeState, SessionSummary } from '../src/renderer/src/types'

const baseSession: SessionSummary = {
  path: 'session-a',
  id: 'session-a',
  created: '2026-09-06T00:00:00.000Z',
  modified: '2026-09-06T00:00:00.000Z',
  messageCount: 1,
  firstMessage: '测试模型是否可用',
  status: 'idle',
  unreadKind: null
}

function renderSidebar(
  sessions: SessionSummary[],
  getSessionRuntimeState?: (path: string, cwd: string) => SessionRuntimeState | null,
  options: { hideWindowDragSpacer?: boolean; compactHoverPreview?: boolean } = {}
): string {
  const theme = createTheme()
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme },
      createElement(SessionSidebar, {
        mode: 'conversations',
        hideWindowDragSpacer: options.hideWindowDragSpacer,
        compactHoverPreview: options.compactHoverPreview,
        sessions,
        activeSessionPath: sessions[0]?.path ?? null,
        activeCwd: '/workspace',
        projects: [],
        projectSessionRefreshKey: 0,
        onNewChat: () => undefined,
        onNewProject: () => undefined,
        onSelectSession: () => undefined,
        onRenameSession: () => undefined,
        onDeleteSession: () => undefined,
        onStartProjectChat: () => undefined,
        onDeleteProject: () => undefined,
        onFetchProjectSessions: async () => [],
        getSessionRuntimeState
      })
    )
  )
}

test('project sidebar expands the active project by cwd', () => {
  const expanded = expandActiveProjectId(
    new Set<string>(),
    'projects',
    [
      { id: 'alpha', workingDirectory: '/projects/alpha' },
      { id: 'beta', workingDirectory: '/projects/beta' }
    ],
    '/projects/beta'
  )

  assert.deepEqual([...expanded], ['beta'])
})

test('project sidebar treats project membership as a cwd grouping concern', () => {
  const projects = [
    { id: 'alpha', workingDirectory: '/projects/alpha' },
    { id: 'beta', workingDirectory: '/projects/beta' }
  ]

  assert.equal(activeCwdBelongsToProject(projects, '/projects/beta'), true)
  assert.equal(activeCwdBelongsToProject(projects, '/ordinary/workspace'), false)
  assert.deepEqual(
    orderProjectsForSessionSelection(projects, '/projects/beta').map((project) => project.id),
    ['beta', 'alpha']
  )
  assert.deepEqual(
    orderProjectsForSessionSelection(projects, '/ordinary/workspace').map((project) => project.id),
    ['alpha', 'beta']
  )
})

test('project sidebar leaves expansion unchanged outside project mode', () => {
  const current = new Set<string>(['alpha'])
  const expanded = expandActiveProjectId(
    current,
    'conversations',
    [{ id: 'beta', workingDirectory: '/projects/beta' }],
    '/projects/beta'
  )

  assert.equal(expanded, current)
  assert.deepEqual([...expanded], ['alpha'])
})

test('project sidebar allows the active project to be manually collapsed', () => {
  const expanded = resolveProjectExpandedIds(
    { beta: false },
    'projects',
    [
      { id: 'alpha', workingDirectory: '/projects/alpha' },
      { id: 'beta', workingDirectory: '/projects/beta' }
    ],
    '/projects/beta'
  )

  assert.deepEqual([...expanded], [])
})

test('project sidebar keeps explicit expansion while auto-expanding the active project', () => {
  const expanded = resolveProjectExpandedIds(
    { alpha: true },
    'projects',
    [
      { id: 'alpha', workingDirectory: '/projects/alpha' },
      { id: 'beta', workingDirectory: '/projects/beta' }
    ],
    '/projects/beta'
  )

  assert.deepEqual([...expanded], ['alpha', 'beta'])
})

test('session sidebar shows a contained breathing beacon before running conversation titles', () => {
  const markup = renderSidebar([{ ...baseSession, status: 'running' }])

  assert.match(markup, /aria-label="会话运行中"/)
  assert.match(markup, /data-phi-slot="session-attention-beacon-slot"/)
  assert.match(markup, /data-phi-slot="session-attention-beacon"/)
  assert.match(markup, /data-phi-beacon-kind="running"/)
  assert.match(markup, /justify-content:center/)
  assert.match(markup, /width:16px/)
  assert.match(markup, /width:8px/)
  assert.match(markup, /height:8px/)
  assert.doesNotMatch(markup, /::after/)
  assert.doesNotMatch(markup, /inset:-4px/)
  assert.doesNotMatch(markup, /scale\(1\.9\)/)
  assert.match(markup, /测试模型是否可用/)
  assert.match(markup, /运行中/)
})

test('session sidebar keeps a solid beacon for completed unread conversations', () => {
  const markup = renderSidebar([
    { ...baseSession, status: 'completed_unread', unreadKind: 'completed' }
  ])

  assert.match(markup, /aria-label="会话已完成未读"/)
  assert.match(markup, /data-phi-slot="session-attention-beacon-slot"/)
  assert.match(markup, /data-phi-slot="session-attention-beacon"/)
  assert.match(markup, /data-phi-beacon-kind="completed"/)
  assert.match(markup, /animation:none/)
  assert.match(markup, /已完成/)
})

test('session sidebar title ignores composer file reference metadata', () => {
  const markup = renderSidebar([
    { ...baseSession, firstMessage: '引用文件：`./data.json`\n分析这个数据' }
  ])

  assert.match(markup, /分析这个数据/)
  assert.doesNotMatch(markup, /引用文件：/)
})

test('session sidebar does not show the running beacon for idle conversations', () => {
  const markup = renderSidebar([baseSession])

  assert.doesNotMatch(markup, /aria-label="会话运行中"/)
  assert.doesNotMatch(markup, /data-phi-slot="session-attention-beacon-slot"/)
  assert.doesNotMatch(markup, /data-phi-slot="session-attention-beacon"/)
})

test('embedded session sidebar fills menu width without the window drag spacer', () => {
  const markup = renderSidebar([baseSession], undefined, { hideWindowDragSpacer: true })

  assert.match(markup, /class="[^"]*app-sidebar-surface/)
  assert.match(markup, /width:100%/)
  assert.match(markup, /min-width:0/)
  assert.doesNotMatch(markup, /min-height:44px;padding-left:80px/)
})

test('hover preview session sidebar stays compact and scrolls its own list', () => {
  const markup = renderSidebar(
    [baseSession, { ...baseSession, path: 'session-b', id: 'session-b', firstMessage: '第二段' }],
    undefined,
    { hideWindowDragSpacer: true, compactHoverPreview: true }
  )

  assert.match(markup, /data-phi-session-sidebar-variant="hover-preview"/)
  assert.match(markup, /height:auto/)
  assert.match(markup, /max-height:min\(420px, calc\(100vh - 96px\)\)/)
  assert.match(markup, /flex:0 1 auto/)
  assert.match(markup, /max-height:min\(320px, calc\(100vh - 176px\)\)/)
  assert.doesNotMatch(markup, /height:100%/)
})

test('hover preview project actions keep their menu above the flyout', () => {
  const sidebarSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/components/SessionSidebar.tsx'),
    'utf8'
  )
  const projectRowSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/components/session-sidebar/ProjectRow.tsx'),
    'utf8'
  )
  const deleteDialogsSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/components/session-sidebar/SessionDeleteDialogs.tsx'),
    'utf8'
  )

  assert.match(sidebarSource, /onPreviewInteractionChange\?: \(active: boolean\) => void/)
  assert.match(projectRowSource, /menuAnchor === null/)
  assert.match(projectRowSource, /theme\.zIndex\.tooltip \+ 1/)
  assert.match(deleteDialogsSource, /theme\.zIndex\.tooltip \+ 2/)
})

test('session running beacon slot stays centered in ordinary and indented gutters', () => {
  assert.equal(sessionRunningBeaconSlotWidth(false), 16)
  assert.equal(sessionRunningBeaconSlotWidth(true), 32)
})

test('session beacon kind covers durable attention states', () => {
  assert.equal(sessionBeaconKind({ status: 'running' }), 'running')
  assert.equal(sessionBeaconKind({ status: 'idle', unreadKind: 'completed' }), 'completed')
  assert.equal(sessionBeaconKind({ status: 'idle', unreadKind: 'failed' }), 'failed')
  assert.equal(sessionBeaconKind({ status: 'needs_approval', unreadKind: 'approval' }), 'approval')
  assert.equal(sessionBeaconKind({ status: 'idle', unreadKind: null }), null)
})

test('session sidebar uses live runtime state before persisted summaries refresh', () => {
  const markup = renderSidebar([baseSession], (path, cwd) => {
    assert.equal(path, 'session-a')
    assert.equal(cwd, '/workspace')
    return {
      status: 'running',
      unreadKind: null,
      currentRunId: 'run-a',
      currentRunStartedAt: '2026-09-07T00:00:00.000Z'
    }
  })

  assert.match(markup, /aria-label="会话运行中"/)
  assert.match(markup, /运行中/)
})

test('session sidebar applies manual order without dropping new conversations', () => {
  const second = { ...baseSession, path: 'session-b', id: 'session-b', firstMessage: '第二段' }
  const third = { ...baseSession, path: 'session-c', id: 'session-c', firstMessage: '第三段' }

  const ordered = orderSessionsForDisplay([baseSession, second, third], ['session-b'])

  assert.deepEqual(
    ordered.map((session) => session.path),
    ['session-b', 'session-a', 'session-c']
  )
})

test('session sidebar detects activity-time sorted refreshes', () => {
  const older = {
    ...baseSession,
    path: 'session-old',
    id: 'session-old',
    modified: '2026-09-06T00:00:00.000Z'
  }
  const newer = {
    ...baseSession,
    path: 'session-new',
    id: 'session-new',
    modified: '2026-09-06T00:02:00.000Z'
  }

  assert.equal(isSessionListSortedByActivityTime([newer, older]), true)
  assert.equal(isSessionListSortedByActivityTime([older, newer]), false)
})

test('session sidebar keeps implicit order stable across summary refreshes', () => {
  const second = { ...baseSession, path: 'session-b', id: 'session-b', firstMessage: '第二段' }
  const refreshed = [
    {
      ...second,
      modified: '2026-09-06T00:02:00.000Z'
    },
    {
      ...baseSession,
      status: 'completed_unread' as const,
      unreadKind: 'completed' as const,
      modified: '2026-09-06T00:01:00.000Z'
    }
  ]
  const ordered = preserveSessionListOrder([baseSession, second], refreshed)

  assert.deepEqual(
    ordered.map((session) => session.path),
    ['session-a', 'session-b']
  )
  assert.equal(ordered[0].unreadKind, 'completed')
})

test('session sidebar accepts refresh order when it is not activity-time sorted', () => {
  const older = {
    ...baseSession,
    path: 'session-old',
    id: 'session-old',
    modified: '2026-09-06T00:00:00.000Z'
  }
  const newer = {
    ...baseSession,
    path: 'session-new',
    id: 'session-new',
    modified: '2026-09-06T00:02:00.000Z'
  }

  const ordered = preserveSessionListOrder([newer, older], [older, newer])

  assert.deepEqual(
    ordered.map((session) => session.path),
    ['session-old', 'session-new']
  )
})
