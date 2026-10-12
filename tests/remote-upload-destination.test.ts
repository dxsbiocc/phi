import assert from 'node:assert/strict'
import test from 'node:test'

import {
  clearRemoteUploadDestinations,
  remoteUploadDestinationDirectory,
  rememberRemoteUploadDestination,
  selectedRemoteUploadDestination
} from '../src/renderer/src/lib/remoteUploadDestination'

test('remote upload destinations stay project-scoped and map SSH URIs to project-relative directories', () => {
  clearRemoteUploadDestinations()
  rememberRemoteUploadDestination('project-a', 'ssh://cluster/data/project/reads')
  rememberRemoteUploadDestination('project-b', 'ssh://cluster/other')
  assert.equal(selectedRemoteUploadDestination('project-a'), 'ssh://cluster/data/project/reads')
  assert.equal(selectedRemoteUploadDestination('project-b'), 'ssh://cluster/other')
  assert.equal(
    remoteUploadDestinationDirectory(
      'ssh://cluster/data/project/reads',
      'cluster',
      '/data/project'
    ),
    'reads'
  )
  assert.equal(
    remoteUploadDestinationDirectory('ssh://cluster/data/project', 'cluster', '/data/project'),
    ''
  )
  assert.equal(
    remoteUploadDestinationDirectory('ssh://other/data/project', 'cluster', '/data/project'),
    null
  )
})
