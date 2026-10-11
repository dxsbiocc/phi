import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  FileTransferManager,
  FileTransferRegistry,
  LocalTransferDataPlane,
  type TransferRequest
} from '../src/main/agent/transfer'

test('local destination keys normalize path aliases for the single-destination queue lock', () => {
  const plane = new LocalTransferDataPlane()
  const request = (transferId: string, path: string): TransferRequest => ({
    transferId,
    direction: 'local',
    hostKey: 'local',
    dataPlaneId: 'local',
    source: { kind: 'local-path', path: '/authorized/source.bin' },
    destination: { kind: 'local-path', path }
  })

  assert.equal(
    plane.destinationKey(request('plain', '/authorized/output.bin')),
    plane.destinationKey(request('alias', '/authorized/nested/../output.bin'))
  )
})

test('local preflight refuses a symbolic-link source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-transfer-source-symlink-'))
  try {
    const realSource = join(root, 'real.bin')
    const linkedSource = join(root, 'linked.bin')
    const destination = join(root, 'saved.bin')
    writeFileSync(realSource, 'private source')
    symlinkSync(realSource, linkedSource)
    const handle = new FileTransferManager({
      registry: new FileTransferRegistry(join(root, 'registry.json')),
      dataPlanes: [new LocalTransferDataPlane()]
    }).enqueue({
      transferId: 'source-symlink',
      direction: 'local',
      hostKey: 'local',
      dataPlaneId: 'local',
      source: { kind: 'local-path', path: linkedSource },
      destination: { kind: 'local-path', path: destination }
    })

    await assert.rejects(handle.completion, { code: 'SOURCE_CHANGED' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
