import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'

import { ProjectRow } from '../src/renderer/src/components/session-sidebar/ProjectRow'
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

test('SSH project sidebar row offers a conversation while explaining tool limits', () => {
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
  assert.match(markup, /服务器离线/)
  assert.match(markup, /远程读取、搜索、命令和文件新建、修改已可用/)
  assert.match(markup, /修改前需先读取/)
  assert.match(markup, /新对话（远程文件与命令工具已可用）/)
  assert.match(markup, /Git、Notebook 和项目级 Skills\/MCP 暂未支持/)
  assert.equal(fetched, false)
})
