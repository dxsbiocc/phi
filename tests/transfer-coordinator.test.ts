import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FileTransferCoordinator } from '../src/main/agent/transfer/coordinator'
import { FileTransferRegistry, LocalTransferDataPlane } from '../src/main/agent/transfer'
import type {
  TransferCopyOptions,
  TransferDataPlane,
  TransferDataPlaneSession
} from '../src/main/agent/transfer'

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for coordinated transfer')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('dynamically registered consumers share the same per-host transfer queue', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-transfer-coordinator-'))
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  let active = 0
  let maximumActive = 0
  let started = 0
  const local = new LocalTransferDataPlane()
  const plane = (id: string): TransferDataPlane => ({
    id,
    destinationKey: (request) => local.destinationKey(request),
    async open(request): Promise<TransferDataPlaneSession> {
      const session = await local.open(request)
      return new Proxy(session, {
        get(target, property, receiver) {
          if (property === 'copy') {
            return async (options: TransferCopyOptions): Promise<void> => {
              started += 1
              active += 1
              maximumActive = Math.max(maximumActive, active)
              try {
                await gate
                await target.copy(options)
              } finally {
                active -= 1
              }
            }
          }
          const value = Reflect.get(target, property, receiver) as unknown
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
    }
  })
  try {
    const registry = new FileTransferRegistry(join(root, 'registry.json'))
    await registry.upsert({
      transferId: 'coordinated-two',
      hostKey: 'same-host',
      cleanupOwner: 'consumer-1',
      storageKey: 'same-host',
      partialLocator: 'queued.part',
      manifestLocator: 'queued.part.json',
      status: 'cancelled',
      retainedBytes: 10,
      createdAt: 1,
      updatedAt: 1
    })
    const coordinator = new FileTransferCoordinator({
      registry
    })
    const completions = ['one', 'two'].map((name, index) => {
      const source = join(root, `${name}.source`)
      writeFileSync(source, name)
      return coordinator.enqueue(
        {
          transferId: `coordinated-${name}`,
          direction: 'local',
          hostKey: 'same-host',
          source: { kind: 'local-path', path: source },
          destination: { kind: 'local-path', path: join(root, `${name}.saved`) }
        },
        plane(`consumer-${index}`)
      ).completion
    })

    await waitFor(() => started === 1)
    assert.equal(active, 1)
    await coordinator.cleanupRetained({
      hostKey: 'same-host',
      cleanupOwner: 'consumer-1',
      storageKey: 'same-host',
      freeBytes: 1,
      now: 1_900_000_000_000,
      removeOwned: async () => assert.fail('queued transfer partial must remain in use')
    })
    release()
    await Promise.all(completions)
    assert.equal(maximumActive, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('retention removal and resume reservation are atomic per transfer id', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-transfer-coordinator-cleanup-race-'))
  try {
    const registry = new FileTransferRegistry(join(root, 'registry.json'))
    await registry.upsert({
      transferId: 'race-transfer',
      hostKey: 'host-a',
      cleanupOwner: 'owner-a',
      storageKey: 'storage-a',
      partialLocator: 'race.part',
      manifestLocator: 'race.part.json',
      status: 'cancelled',
      retainedBytes: 10,
      createdAt: 1,
      updatedAt: 1
    })
    const coordinator = new FileTransferCoordinator({ registry })
    let entered = false
    let allowRemove!: () => void
    const removalGate = new Promise<void>((resolve) => (allowRemove = resolve))
    const cleanup = coordinator.cleanupRetained({
      hostKey: 'host-a',
      cleanupOwner: 'owner-a',
      storageKey: 'storage-a',
      freeBytes: 1,
      now: 1_900_000_000_000,
      removeOwned: async () => {
        entered = true
        await removalGate
      }
    })
    await waitFor(() => entered)

    assert.throws(() => coordinator.reserveRetention('race-transfer'), /already registered/)
    allowRemove()
    await cleanup
    const release = coordinator.reserveRetention('race-transfer')
    release()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
