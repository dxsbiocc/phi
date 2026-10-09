import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import SessionSidebar from '../src/renderer/src/components/SessionSidebar'
import {
  filterSessionSummaries,
  normalizeSessionQuery
} from '../src/renderer/src/features/session-search/lib/sessionFilter'
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
import { editableSessionTitle, sessionTitle } from '../src/renderer/src/lib/sessionSidebarShared'
import { orderSessionsForDisplay } from '../src/renderer/src/lib/sessionOrder'
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

test('recent conversations move above older history after a refresh', () => {
  const older = { ...baseSession, path: 'older', modified: '2026-09-18T00:00:00Z' }
  const recent = { ...baseSession, path: 'recent', modified: '2026-10-04T00:00:00Z' }
  const latest = { ...baseSession, path: 'latest', modified: '2026-10-04T01:00:00Z' }

  assert.deepEqual(
    orderSessionsForDisplay([older, recent, latest]).map((s) => s.path),
    ['latest', 'recent', 'older']
  )
})

function renderSidebar(
  sessions: SessionSummary[],
  getSessionRuntimeState?: (
    path: string,
    cwd: string,
    phiSessionId?: string | null
  ) => SessionRuntimeState | null,
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
        onExportSession: () => undefined,
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

test('session search matches titles and first messages without changing their order', () => {
  const sessions = [
    { ...baseSession, name: 'Alpha report', firstMessage: '开始分析' },
    {
      ...baseSession,
      path: 'session-b',
      id: 'session-b',
      name: 'Beta',
      firstMessage: '分析 ALPHA 数据'
    },
    { ...baseSession, path: 'session-c', id: 'session-c', name: 'Gamma', firstMessage: '无关内容' }
  ]
  const query = normalizeSessionQuery('  ＡＬＰＨＡ  ')
  assert.equal(query, 'alpha')
  assert.deepEqual(
    filterSessionSummaries(sessions, query).map((session) => session.path),
    ['session-a', 'session-b']
  )
  assert.equal(filterSessionSummaries(sessions, '').length, 3)
  assert.equal(sessions.length, 3)
})

test('session sidebar leaves search to the top-left dialog', () => {
  assert.doesNotMatch(renderSidebar([baseSession]), /aria-label="查找会话"/)
})

test('session sidebar does not show the running beacon for idle conversations', () => {
  const markup = renderSidebar([baseSession])

  assert.doesNotMatch(markup, /aria-label="会话运行中"/)
  assert.doesNotMatch(markup, /data-phi-slot="session-attention-beacon-slot"/)
  assert.doesNotMatch(markup, /data-phi-slot="session-attention-beacon"/)
})

test('session sidebar renders the selected conversation as a pill row', () => {
  const markup = renderSidebar([baseSession])
  const rowSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/components/session-sidebar/SessionRow.tsx'),
    'utf8'
  )
  assert.match(markup, /data-phi-session-row="active"/)
  assert.doesNotMatch(markup, /data-phi-session-active-icon="true"/)
  assert.match(markup, /border-radius:999px/)
  assert.doesNotMatch(markup, /font-weight:800/)
  assert.doesNotMatch(markup, /inset 3px 0 0/)
  assert.doesNotMatch(
    rowSource,
    /className="session-actions"[\s\S]{0,240}bgcolor: 'background\.default'/
  )
  const actionStyles = rowSource
    .split('const sessionActionButtonSx = {')[1]
    ?.split('const sessionMenuItemSx')[0]
  assert.ok(actionStyles)
  assert.doesNotMatch(actionStyles, /border:|borderColor:|background\.paper|action\.selected/)
})

test('session rows keep rename, export, and delete inside one actions menu', () => {
  const markup = renderSidebar([{ ...baseSession, phiSessionId: 'phi-1' }])
  const rowSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/components/session-sidebar/SessionRow.tsx'),
    'utf8'
  )
  const renameSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/features/session-actions/SessionRenamePanel.tsx'),
    'utf8'
  )

  assert.match(markup, /aria-label="更多会话操作"/)
  assert.doesNotMatch(markup, /aria-label="导出会话"/)
  assert.doesNotMatch(markup, /aria-label="重命名"/)
  const rowEnd = rowSource.indexOf('</ListItemButton>')
  const actions = rowSource.indexOf('className="session-actions"')
  assert.ok(rowEnd >= 0 && actions > rowEnd, 'more button must sit outside the conversation row')
  assert.match(rowSource, /<GoPencil aria-hidden size=\{18\} \/>/)
  assert.match(rowSource, /<GoDownload aria-hidden size=\{18\} \/>/)
  assert.match(rowSource, /<GoTrash aria-hidden size=\{18\} \/>/)
  assert.match(rowSource, /<MenuItem[\s\S]{0,100}disabled=\{exportDisabled\}/)
  assert.match(rowSource, /<SessionRenamePanel[\s\S]{0,80}open=\{renameOpen\}/)
  assert.match(renameSource, /<Dialog[\s\S]{0,100}open=\{open\}/)
  assert.match(renameSource, /重命名聊天/)
})

test('rename dialog starts with the full conversation title', () => {
  const longName = '长标题'.repeat(40)
  const session = { ...baseSession, name: longName }

  assert.equal(editableSessionTitle(session), longName)
  assert.notEqual(sessionTitle(session), longName)
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

test('project action visibility does not stick to mouse focus and hover borders stay even', () => {
  const projectRowSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/components/session-sidebar/ProjectRow.tsx'),
    'utf8'
  )

  assert.doesNotMatch(projectRowSource, /focus-within \.project-actions/)
  assert.match(projectRowSource, /:has\(\.project-actions :focus-visible\)/)
  assert.doesNotMatch(projectRowSource, /inset 3px 0 0/)
  assert.match(projectRowSource, /className="project-row-meta"/)
  assert.match(projectRowSource, /&:hover \.project-row-meta/)
  assert.match(projectRowSource, /justifyContent: 'flex-end'/)
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
  assert.equal(sessionBeaconKind({ status: 'needs_input', unreadKind: 'input' }), 'input')
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

test('session sidebar orders history by activity instead of creation or arrival order', () => {
  const older = {
    ...baseSession,
    path: 'older',
    created: '2026-09-01T00:00:00Z',
    modified: '2026-10-04T00:00:00Z',
    lastActivityAt: '2026-10-04T01:00:00Z'
  }
  const newer = {
    ...baseSession,
    path: 'newer',
    created: '2026-10-03T00:00:00Z',
    modified: '2026-10-03T00:01:00Z'
  }
  const source = [newer, older]

  assert.deepEqual(
    orderSessionsForDisplay(source).map((s) => s.path),
    ['older', 'newer']
  )
  assert.deepEqual(
    source.map((s) => s.path),
    ['newer', 'older']
  )
})

test('session activity order falls back through invalid or missing timestamps', () => {
  const sessions = [
    {
      ...baseSession,
      path: 'invalid',
      lastActivityAt: 'invalid',
      modified: 'invalid',
      created: 'invalid'
    },
    {
      ...baseSession,
      path: 'created',
      lastActivityAt: 'invalid',
      modified: '',
      created: '2026-10-02T00:00:00Z'
    },
    {
      ...baseSession,
      path: 'modified',
      lastActivityAt: 'invalid',
      modified: '2026-10-03T00:00:00Z'
    },
    { ...baseSession, path: 'activity', lastActivityAt: '2026-10-04T00:00:00Z' }
  ]

  assert.deepEqual(
    orderSessionsForDisplay(sessions).map((s) => s.path),
    ['activity', 'modified', 'created', 'invalid']
  )
})

test('equal activity times have a stable order across refreshes', () => {
  const a = { ...baseSession, path: 'session-a' }
  const b = { ...baseSession, path: 'session-b', status: 'failed' as const }

  assert.deepEqual(
    orderSessionsForDisplay([b, a]).map((s) => s.path),
    ['session-a', 'session-b']
  )
  assert.deepEqual(
    orderSessionsForDisplay([a, b]).map((s) => s.path),
    ['session-a', 'session-b']
  )
})

test('session sidebar uses live activity to order a background conversation before refresh', () => {
  const older = {
    ...baseSession,
    path: 'older',
    phiSessionId: 'phi-older',
    firstMessage: '旧会话继续工作'
  }
  const newer = {
    ...baseSession,
    path: 'newer',
    modified: '2026-10-03T00:00:00Z',
    firstMessage: '昨天的会话'
  }
  const markup = renderSidebar([newer, older], (_path, _cwd, phiSessionId) =>
    phiSessionId === 'phi-older'
      ? { status: 'running', unreadKind: null, lastActivityAt: '2026-10-04T00:00:00Z' }
      : null
  )

  assert.ok(markup.indexOf('旧会话继续工作') < markup.indexOf('昨天的会话'))
})

test('session rows give the title all resting space and expose its full accessible name', () => {
  const fullTitle = '一个很长的完整对话标题'.repeat(15)
  const markup = renderSidebar([{ ...baseSession, name: fullTitle }])

  assert.match(markup, new RegExp(`aria-label="${fullTitle}"`))
  assert.doesNotMatch(markup, /session-time|分钟前|小时前|天前|2026\/09\/06/)
})
