import assert from 'node:assert/strict'
import test from 'node:test'

import { shouldRefreshProjectGitStatusForAgentEvent } from '../src/renderer/src/lib/projectGitRefresh'

const projects = [
  {
    workingDirectory: '/workspace/project-a'
  },
  {
    workingDirectory: '/workspace/project-b'
  }
]

test('project git refresh runs only for terminal events in known project cwd', () => {
  assert.equal(
    shouldRefreshProjectGitStatusForAgentEvent(
      { type: 'run_completed', cwd: '/workspace/project-a' },
      projects
    ),
    true
  )
  assert.equal(
    shouldRefreshProjectGitStatusForAgentEvent(
      { type: 'run_failed', cwd: '/workspace/project-b' },
      projects
    ),
    true
  )
  assert.equal(
    shouldRefreshProjectGitStatusForAgentEvent(
      { type: 'run_interrupted', cwd: '/workspace/project-a' },
      projects
    ),
    true
  )
})

test('project git refresh skips streaming and ordinary workspace events', () => {
  assert.equal(
    shouldRefreshProjectGitStatusForAgentEvent(
      { type: 'message_update', cwd: '/workspace/project-a' },
      projects
    ),
    false
  )
  assert.equal(
    shouldRefreshProjectGitStatusForAgentEvent(
      { type: 'run_completed', cwd: '/workspace/ordinary' },
      projects
    ),
    false
  )
  assert.equal(
    shouldRefreshProjectGitStatusForAgentEvent({ type: 'run_completed' }, projects),
    false
  )
})
