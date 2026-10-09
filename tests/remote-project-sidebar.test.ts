import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'

import { ProjectRow } from '../src/renderer/src/components/session-sidebar/ProjectRow'
import { ProjectHoverCard } from '../src/renderer/src/components/session-sidebar/ProjectHoverCard'
import {
  projectHoverDetailRows,
  projectRowMetaLabel
} from '../src/renderer/src/components/session-sidebar/projectHoverDetails'
import { projectLocationSummary, type Project } from '../src/renderer/src/lib/projectTypes'
import {
  activeCwdBelongsToProject,
  resolveProjectExpandedIds
} from '../src/renderer/src/lib/projectSidebar'
import { workspaceScopeLabelForCwd } from '../src/renderer/src/lib/workspaceScope'

const remote: Project = {
  id: 'remote-1',
  name: 'Cluster project',
  location: {
    kind: 'ssh',
    hostProfileId: 'host-1',
    remoteRoot: '/cluster/work',
    canonicalRoot: '/data/work'
  },
  workingDirectory: '/cluster/work',
  permissionMode: 'ask',
  remoteReachability: 'offline',
  remoteHostAlias: 'lab-hpc',
  createdAt: '2026-09-24T00:00:00.000Z'
}

test('unreachable SSH project is identified by host and path, not a missing local directory', () => {
  assert.equal(projectLocationSummary(remote), 'lab-hpc · /cluster/work · 服务器离线')
  assert.equal(activeCwdBelongsToProject([remote], '/cluster/work'), false)
  assert.equal(workspaceScopeLabelForCwd('/cluster/work', [remote]), '普通')
  const other = { ...remote, id: 'remote-2' }
  assert.deepEqual(
    [...resolveProjectExpandedIds({}, 'projects', [remote, other], '/internal/anchor', other.id)],
    ['remote-2']
  )
})

test('SSH project sidebar row shows only its server identity above conversations', () => {
  let fetched = false
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(ProjectRow, {
        project: remote,
        expanded: true,
        refreshKey: 0,
        onToggleExpanded: () => undefined,
        activeSessionPath: null,
        onStartChat: () => undefined,
        onSelectSession: () => undefined,
        onRenameSession: () => undefined,
        onDeleteSession: () => undefined,
        onDeleteProject: () => undefined,
        onFetchSessions: async () => {
          fetched = true
          return []
        }
      })
    )
  )
  assert.match(markup, /lab-hpc/)
  assert.doesNotMatch(markup, /\/cluster\/work/)
  assert.doesNotMatch(markup, /服务器离线/)
  assert.doesNotMatch(markup, /远程读取、搜索、命令和文件新建、修改已可用/)
  assert.doesNotMatch(markup, /修改前需先读取/)
  assert.match(markup, /新对话/)
  assert.doesNotMatch(markup, /Git、Notebook 和项目级 Skills\/MCP 暂未支持/)
  assert.equal(fetched, false)
})

test('project hover details carry server, path, permission and conversation metadata', () => {
  const details = projectHoverDetailRows(remote, true, 3)
  assert.deepEqual(details, [
    { label: '服务器', value: 'lab-hpc' },
    { label: '位置', value: '/cluster/work' },
    { label: '权限', value: '重要操作前询问' },
    { label: '对话', value: '3 个' }
  ])

  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(ProjectHoverCard, { project: remote, sessionsReady: true, sessionCount: 3 })
    )
  )
  assert.match(markup, /远程项目/)
  assert.match(markup, /lab-hpc/)
  assert.match(markup, /\/cluster\/work/)
  assert.match(markup, /3 个/)
})

test('project rows use one compact right-side server or Git label', () => {
  assert.equal(projectRowMetaLabel(remote), 'lab-hpc')
  assert.equal(
    projectRowMetaLabel({
      ...remote,
      location: { kind: 'local', path: '/work/test', realPath: '/work/test' },
      remoteHostAlias: undefined,
      gitStatus: { branch: 'main', dirty: true }
    }),
    'main · 有改动'
  )
})
