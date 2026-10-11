import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  FileTransferManager,
  FileTransferRegistry,
  LocalTransferDataPlane,
  type TransferRequest
} from '../src/main/agent/transfer'
import {
  hashVerifiedLocalFile,
  publishVerifiedLocalFile
} from '../src/main/agent/transfer/ssh-data-plane-local'

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

test('verified local publish refuses a late symbolic-link partial swap', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-transfer-publish-symlink-'))
  try {
    const partial = join(root, 'partial.bin')
    const replacement = join(root, 'replacement.bin')
    const destination = join(root, 'saved.bin')
    writeFileSync(partial, 'verified payload', { mode: 0o600 })
    writeFileSync(replacement, 'attacker payload', { mode: 0o600 })
    const verified = await hashVerifiedLocalFile(partial, 1024)
    rmSync(partial)
    symlinkSync(replacement, partial)

    await assert.rejects(
      publishVerifiedLocalFile(partial, destination, verified),
      (error: unknown) =>
        ['ELOOP', 'INVALID_PARTIAL'].includes(String((error as { code?: unknown })?.code))
    )
    assert.equal(existsSync(destination), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
