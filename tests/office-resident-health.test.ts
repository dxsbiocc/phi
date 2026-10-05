import assert from 'node:assert/strict'
import { test } from 'node:test'

import { OfficeDocumentOperationQueue } from '../src/main/agent/office/office-operation-queue'
import { OfficeResidentHealth } from '../src/main/agent/office/office-resident-health'
import type { OwnedOfficeDocument } from '../src/main/agent/office/office-service-state'

function ownedDocument(): OwnedOfficeDocument {
  return {
    key: 'session-1\0source.xlsx',
    binaryPath: '/officecli',
    panelReferences: 1,
    lastActivityAt: 1,
    contentRevision: 7,
    readOnly: false,
    needsSave: false,
    saveStatus: { saveState: 'saved', lastSavedRevision: 7 },
    operationLog: { version: 2, contentRevision: 7, operations: {} },
    operations: new OfficeDocumentOperationQueue(),
    document: {
      artifactId: 'artifact-1',
      sessionId: 'session-1',
      projectId: 'project-1',
      sourcePath: '/project/source.xlsx',
      sourceHash: 'hash',
      draftPath: '/session/artifacts/office/artifact-1/source.xlsx',
      residentPid: 101,
      watchPid: 202,
      watchPort: 31_001,
      gatewayPort: 42_001,
      previewUrl: 'http://127.0.0.1:42001/'
    }
  }
}

test('a dead resident is rebuilt before the operation without changing document revision', async () => {
  const owned = ownedDocument()
  const recovered: Array<{ residentAlive: boolean; watchAlive: boolean }> = []
  const health = new OfficeResidentHealth({
    isAlive: (pid) => pid === 202,
    recover: async (_owned, state) => {
      recovered.push(state)
      return {
        residentPid: 303,
        watchPid: 404,
        watchPort: 31_002,
        gatewayPort: 42_002,
        previewUrl: 'http://127.0.0.1:42002/'
      }
    }
  })

  await health.ensure(owned, new AbortController().signal)

  assert.deepEqual(recovered, [{ residentAlive: false, watchAlive: true }])
  assert.equal(owned.contentRevision, 7)
  assert.equal(owned.document.residentPid, 303)
  assert.equal(owned.document.watchPid, 404)
  assert.equal(owned.document.previewUrl, 'http://127.0.0.1:42002/')
})

test('a dead watch is rebuilt once for concurrent operations and publishes its replacement URL', async () => {
  const owned = ownedDocument()
  let recoveries = 0
  let finishRecovery!: () => void
  const recoveryPending = new Promise<void>((resolve) => {
    finishRecovery = resolve
  })
  const health = new OfficeResidentHealth({
    isAlive: (pid) => pid === 101,
    recover: async () => {
      recoveries += 1
      await recoveryPending
      return {
        residentPid: 101,
        watchPid: 505,
        watchPort: 31_005,
        gatewayPort: 42_005,
        previewUrl: 'http://127.0.0.1:42005/'
      }
    }
  })

  const first = health.ensure(owned, new AbortController().signal)
  const second = health.ensure(owned, new AbortController().signal)
  finishRecovery()
  await Promise.all([first, second])

  assert.equal(recoveries, 1)
  assert.equal(owned.document.residentPid, 101)
  assert.equal(owned.document.watchPid, 505)
  assert.equal(owned.document.previewUrl, 'http://127.0.0.1:42005/')
  assert.equal(owned.contentRevision, 7)
})
