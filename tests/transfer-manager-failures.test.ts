import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  FileTransferManager,
  FileTransferRegistry,
  LocalTransferDataPlane,
  type TransferDataPlane,
  type TransferDataPlaneSession,
  type TransferRequest
} from '../src/main/agent/transfer'

function request(root: string, transferId: string, dataPlaneId: string): TransferRequest {
  const source = join(root, `${transferId}.source`)
  writeFileSync(source, Buffer.alloc(2 * 1024 * 1024, 0x31))
  return {
    transferId,
    direction: 'local',
    hostKey: 'local',
    dataPlaneId,
    source: { kind: 'local-path', path: source },
    destination: { kind: 'local-path', path: join(root, `${transferId}.saved`) }
  }
}

function noHashPlane(): TransferDataPlane {
  const local = new LocalTransferDataPlane()
  return {
    id: 'no-hash',
    destinationKey: (transfer) => local.destinationKey(transfer),
    open: async (transfer): Promise<TransferDataPlaneSession> => {
      const session = await local.open(transfer)
      return new Proxy(session, {
        get(target, property, receiver) {
          if (property === 'preflight') {
            return async (signal: AbortSignal) => ({
              ...(await target.preflight(signal)),
              sourceHashAvailable: false,
              destinationHashAvailable: false
            })
          }
          const value = Reflect.get(target, property, receiver) as unknown
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
    }
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for transfer state')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('preflight failure does not register a phantom partial', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-transfer-phantom-'))
  try {
    const registry = new FileTransferRegistry(join(root, 'registry.json'))
    const handle = new FileTransferManager({ registry, dataPlanes: [noHashPlane()] }).enqueue(
      request(root, 'phantom', 'no-hash')
    )

    await assert.rejects(handle.completion, { code: 'HASH_UNAVAILABLE' })
    assert.deepEqual(await registry.list(), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('retention bookkeeping failure cannot leave completion pending', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-transfer-settle-'))
  try {
    const local = new LocalTransferDataPlane()
    let inspections = 0
    const failingRetentionPlane: TransferDataPlane = {
      id: 'inspection-fails',
      destinationKey: (transfer) => local.destinationKey(transfer),
      open: async (transfer): Promise<TransferDataPlaneSession> => {
        const session = await local.open(transfer)
        return new Proxy(session, {
          get(target, property, receiver) {
            if (property === 'inspectPartial') {
              return async () => {
                inspections += 1
                if (inspections >= 4) throw new Error('retention inspection unavailable')
                return target.inspectPartial()
              }
            }
            const value = Reflect.get(target, property, receiver) as unknown
            return typeof value === 'function' ? value.bind(target) : value
          }
        })
      }
    }
    const transfer = request(root, 'settles', 'inspection-fails')
    const handle = new FileTransferManager({
      registry: new FileTransferRegistry(join(root, 'registry.json')),
      dataPlanes: [failingRetentionPlane]
    }).enqueue({ ...transfer, expectedSha256: '0'.repeat(64) })

    await assert.rejects(
      Promise.race([
        handle.completion,
        new Promise((_, reject) => setTimeout(() => reject(new Error('completion timed out')), 500))
      ]),
      { code: 'TRANSFER_FAILED' }
    )
    assert.ok(inspections >= 4)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cancelling a paused retained transfer records cancelled retention state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-transfer-paused-retain-'))
  try {
    const registry = new FileTransferRegistry(join(root, 'registry.json'))
    const manager = new FileTransferManager({
      registry,
      dataPlanes: [new LocalTransferDataPlane()],
      policy: { chunkSizeBytes: 1024 * 1024, progressBytes: 1, progressIntervalMs: 0 },
      onEvent: (event) => {
        if (event.state === 'transferring' && event.bytesTransferred > 0) handle.pause()
      }
    })
    const handle = manager.enqueue(request(root, 'paused-retain', 'local'))
    await waitFor(() => manager.getState('paused-retain') === 'paused')
    handle.cancel()
    await assert.rejects(handle.completion, { code: 'ABORTED' })

    assert.deepEqual(
      (await registry.list()).map(({ transferId, status }) => ({ transferId, status })),
      [{ transferId: 'paused-retain', status: 'cancelled' }]
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('event consumer exceptions cannot break transfer execution', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-transfer-event-listener-'))
  try {
    const result = await new FileTransferManager({
      registry: new FileTransferRegistry(join(root, 'registry.json')),
      dataPlanes: [new LocalTransferDataPlane()],
      onEvent: () => {
        throw new Error('renderer listener failed')
      }
    }).enqueue(request(root, 'listener-safe', 'local')).completion

    assert.equal(result.state, 'saved')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
