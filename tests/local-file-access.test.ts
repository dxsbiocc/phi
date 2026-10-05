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

test('an Office-looking artifact path does not expand the local file allow roots', () => {
  const roots = localFileAllowRoots({
    agentDir: '/phi',
    sessionCwd: '/workspace',
    projectRoots: ['/Work/test']
  })

  assert.equal(
    isLocalFilePathAllowedByRoots(
      '/private/phi/sessions/session-1/artifacts/office/artifact-1/report.xlsx',
      roots
    ),
    false
  )
  assert.equal(
    isLocalFilePathAllowedByRoots(
      '/phi/sessions/session-1/artifacts/office/artifact-1/report.xlsx',
      roots
    ),
    true
  )
})
