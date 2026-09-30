import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isLocalFilePathAllowedByRoots,
  localFileAllowRoots
} from '../src/main/agent/local-file-access'

test('a saved project can be opened while another session directory is current', () => {
  const roots = localFileAllowRoots({
    agentDir: '/phi',
    sessionCwd: '/workspace',
    projectRoots: ['/Work/test', '/data/test']
  })

  assert.equal(isLocalFilePathAllowedByRoots('/Work/test', roots), true)
  assert.equal(isLocalFilePathAllowedByRoots('/Work/test/README.md', roots), true)
  assert.equal(isLocalFilePathAllowedByRoots('/data/test/plots', roots), true)
  assert.equal(isLocalFilePathAllowedByRoots('/phi/sessions/session-1', roots), true)
  assert.equal(isLocalFilePathAllowedByRoots('/workspace/notes.txt', roots), true)
  assert.equal(isLocalFilePathAllowedByRoots('/Work/other', roots), false)
  assert.equal(isLocalFilePathAllowedByRoots('/etc/passwd', roots), false)
})
