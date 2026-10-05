import assert from 'node:assert/strict'
import test from 'node:test'

import type { StartOfficePreviewGatewayInput } from '../src/main/agent/office/office-preview'
import { OfficePreviewProcessManager } from '../src/main/agent/office/office-watch'

test('watch binds human editing to its current artifact and rejects a stale gateway callback', async () => {
  let gatewayInput: StartOfficePreviewGatewayInput | undefined
  const applied: unknown[] = []
  const rejected: unknown[] = []
  const artifact = {
    artifactId: 'artifact-human-watch',
    sessionId: 'session-1',
    projectId: null,
    origin: 'blank' as const,
    sourcePath: null,
    sourceHash: null,
    draftPath: '/sessions/session-1/artifacts/office/artifact-human-watch/blank.xlsx'
  }
  const manager = new OfficePreviewProcessManager(
    {
      availablePort: async () => 31_010,
      startWatch: async (binaryPath, inputArtifact, port) => ({
        artifact: inputArtifact,
        binaryPath,
        pid: 210,
        port,
        stop: async () => undefined
      }),
      startGateway: async (input) => {
        gatewayInput = input
        return {
          artifactId: input.artifactId,
          port: 42_010,
          url: 'http://127.0.0.1:42010/',
          close: async () => undefined
        }
      }
    },
    () => undefined,
    {
      apply: async (edit) => {
        applied.push(edit)
      },
      access: (artifactId) => (artifactId === artifact.artifactId ? 'writable' : 'frozen'),
      rejected: (artifactId, code) => rejected.push({ artifactId, code })
    }
  )

  await manager.start('/officecli', artifact)
  const edit = {
    artifactId: artifact.artifactId,
    operationId: 'human-watch-1',
    sheet: 'Sheet1',
    cell: 'A1',
    text: 'x'
  }
  assert.equal(gatewayInput?.humanEditAccess?.(), 'writable')
  await gatewayInput?.onHumanCellEdit?.(edit)
  gatewayInput?.onHumanEditRejected?.('invalid_edit')
  assert.deepEqual(applied, [edit])
  assert.deepEqual(rejected, [{ artifactId: 'artifact-human-watch', code: 'invalid_edit' }])

  await manager.stop(artifact)
  assert.equal(gatewayInput?.humanEditAccess?.(), 'frozen')
  await assert.rejects(gatewayInput?.onHumanCellEdit?.(edit) ?? Promise.resolve(), /预览已失效/u)
  gatewayInput?.onHumanEditRejected?.('invalid_edit')
  assert.equal(rejected.length, 1)
})
