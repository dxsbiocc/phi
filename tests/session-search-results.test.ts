import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSessionSearchResults } from '../src/renderer/src/features/session-search/lib/sessionSearchResults'
import type { SessionSummary } from '../src/renderer/src/types'

function session(path: string, name: string, modified: string): SessionSummary {
  return {
    id: path,
    path,
    name,
    firstMessage: `${name} 的首条消息`,
    created: modified,
    modified,
    messageCount: 1,
    status: 'idle',
    unreadKind: null
  }
}

const ordinary = [session('ordinary', '普通分析', '2026-09-01T00:00:00Z')]
const projects = [{ id: 'project-a', name: '论文项目' }]
const projectSessions = {
  'project-a': [
    session('project-old', '旧实验', '2026-09-02T00:00:00Z'),
    session('project-new', '新实验', '2026-09-03T00:00:00Z')
  ]
}

test('session search combines ordinary and project sessions by recent activity', () => {
  const results = buildSessionSearchResults(ordinary, projects, projectSessions, '', 12)
  assert.deepEqual(
    results.map(({ session: item, projectName }) => [item.path, projectName]),
    [
      ['project-new', '论文项目'],
      ['project-old', '论文项目'],
      ['ordinary', null]
    ]
  )
})

test('session search matches title, first message, and project name without full text', () => {
  assert.deepEqual(
    buildSessionSearchResults(ordinary, projects, projectSessions, '新实验', 50).map(
      ({ session: item }) => item.path
    ),
    ['project-new']
  )
  assert.deepEqual(
    buildSessionSearchResults(ordinary, projects, projectSessions, '论文项目', 50).map(
      ({ session: item }) => item.path
    ),
    ['project-new', 'project-old']
  )
  assert.deepEqual(
    buildSessionSearchResults(ordinary, projects, projectSessions, '首条消息', 50).map(
      ({ session: item }) => item.path
    ),
    ['project-new', 'project-old', 'ordinary']
  )
})

test('session search deduplicates paths and caps the result list', () => {
  const results = buildSessionSearchResults(
    ordinary,
    projects,
    { 'project-a': [ordinary[0], ...projectSessions['project-a']] },
    '',
    2
  )
  assert.deepEqual(
    results.map(({ session: item }) => item.path),
    ['project-new', 'project-old']
  )
})
