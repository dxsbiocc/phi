import assert from 'node:assert/strict'
import test from 'node:test'

import { approvalDisplayCwd } from '../src/main/agent/session/approval-display-cwd'

const anchor = '/Users/me/.phi/remote-anchors/p1'

test('a remote project approval shows the project path on the server', () => {
  assert.equal(
    approvalDisplayCwd(anchor, {
      kind: 'ssh',
      hostProfileId: 'gpu',
      remoteRoot: '/data/lab/rnaseq',
      canonicalRoot: '/data/lab/rnaseq'
    }),
    '/data/lab/rnaseq'
  )
})

test('a local project approval shows the session directory', () => {
  const local = { kind: 'local', path: '/Users/me/p', realPath: '/Users/me/p' } as const
  assert.equal(approvalDisplayCwd('/Users/me/p', local), '/Users/me/p')
  assert.equal(approvalDisplayCwd(anchor), anchor)
})
