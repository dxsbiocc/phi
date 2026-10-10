import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveProjectRuntimeRoot } from '../src/main/agent/remote-runtime/project-runtime-root'
import type { Project } from '../src/main/agent/projects'

function project(): Project {
  return {
    id: 'project-1',
    name: 'Remote',
    location: {
      kind: 'ssh',
      hostProfileId: 'host-1',
      remoteRoot: '/project',
      canonicalRoot: '/project'
    },
    workingDirectory: '/project',
    workingDirectoryRealPath: '/project',
    permissionMode: 'ask',
    pathAvailable: true,
    createdAt: '2026-10-10T00:00:00.000Z',
    remoteConnections: [
      { id: 'other', label: 'Other', hostProfileId: 'host-2', runtimeRoot: '/other/runtime' },
      {
        id: 'matching',
        label: 'Matching',
        hostProfileId: 'host-1',
        runtimeRoot: '/project/runtime'
      }
    ]
  }
}

test('remote project runtime root falls back to the first connection on its bound host', () => {
  assert.deepEqual(resolveProjectRuntimeRoot(project(), '/host/runtime'), {
    source: 'project',
    configured: '/project/runtime'
  })
})

test('remote project runtime root uses host override when no project connection overrides it', () => {
  const value = project()
  value.remoteConnections = []
  assert.deepEqual(resolveProjectRuntimeRoot(value, '/host/runtime'), {
    source: 'host',
    configured: '/host/runtime'
  })
})
