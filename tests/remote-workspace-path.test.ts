import assert from 'node:assert/strict'
import test from 'node:test'

import {
  remotePathInsideRoot,
  remotePathWithinProjectUri,
  remoteWorkspaceUri,
  tokenizeRemoteWorkspaceUris
} from '../src/shared/remoteWorkspacePath'
import { absoluteWorkspacePath } from '../src/renderer/src/lib/workspacePaths'
import { remoteFileRequestForUri } from '../src/renderer/src/useWorkspaceFileTabs'

const scope = {
  sessionId: 'phi-a',
  projectId: 'project-a',
  hostAlias: 'cluster-a',
  canonicalRoot: '/data/project'
}

test('SSH file URIs preserve special names and become ID-bound project paths', () => {
  const uri = remoteWorkspaceUri('cluster-a', "/data/project/line\n'quote'.txt")
  assert.equal(uri, "ssh://cluster-a/data/project/line%0A'quote'.txt")
  assert.equal(
    remotePathWithinProjectUri(uri, 'cluster-a', '/data/project'),
    "/data/project/line\n'quote'.txt"
  )
  assert.deepEqual(remoteFileRequestForUri(uri, scope), {
    sessionId: 'phi-a',
    projectId: 'project-a',
    path: "/data/project/line\n'quote'.txt"
  })
  assert.equal(absoluteWorkspacePath('/private/local-anchor', uri), uri)
})

test('wrong host, root escape and malformed SSH paths never become local file paths', () => {
  for (const uri of [
    'ssh://cluster-b/data/project/file.txt',
    'ssh://cluster-a/data/project-other/file.txt',
    'ssh://cluster-a/data/project/%2e%2e/secret.txt',
    'ssh://cluster-a/data/project/encoded%2Fslash.txt',
    'ssh://cluster-a/data/project/file.txt?download=1'
  ]) {
    assert.equal(remotePathWithinProjectUri(uri, scope.hostAlias, scope.canonicalRoot), null)
    assert.throws(() => remoteFileRequestForUri(uri, scope), /不属于当前项目/)
  }
  assert.throws(() => remoteFileRequestForUri('ssh://cluster-a/data/project/file', null), /不可用/)
  assert.equal(remotePathInsideRoot('/data/project/file', '/data/project'), true)
  assert.equal(remotePathInsideRoot('/data/project-other/file', '/data/project'), false)
})

test('chat text turns only current-server SSH file references into links', () => {
  const tokens = tokenizeRemoteWorkspaceUris(
    'See ssh://cluster-a/data/project/note.txt, not ssh://cluster-b/data/project/other.txt.',
    scope.hostAlias,
    scope.canonicalRoot
  )
  assert.deepEqual(tokens, [
    { kind: 'text', text: 'See ' },
    { kind: 'path', text: 'ssh://cluster-a/data/project/note.txt', path: '/data/project/note.txt' },
    { kind: 'text', text: ',' },
    { kind: 'text', text: ' not ssh://cluster-b/data/project/other.txt.' }
  ])
})
