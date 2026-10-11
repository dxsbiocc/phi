import assert from 'node:assert/strict'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FileTransferRegistry, type TransferRegistryEntry } from '../src/main/agent/transfer'

test('retention cleanup uses TTL and per-host free-space quota on registry-owned files only', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-transfer-registry-'))
  try {
    const registryPath = join(root, 'registry.json')
    const registry = new FileTransferRegistry(registryPath)
    const now = 1_900_000_000_000
    const day = 24 * 60 * 60 * 1000
    const makeEntry = (
      transferId: string,
      hostKey: string,
      status: TransferRegistryEntry['status'],
      retainedBytes: number,
      updatedAt: number
    ): TransferRegistryEntry => {
      const partialLocator = join(root, `${transferId}.part`)
      const manifestLocator = `${partialLocator}.json`
      writeFileSync(partialLocator, transferId)
      writeFileSync(manifestLocator, '{}')
      return {
        transferId,
        hostKey,
        cleanupOwner: 'test-owner',
        storageKey: 'test-storage',
        status,
        retainedBytes,
        partialLocator,
        manifestLocator,
        createdAt: updatedAt,
        updatedAt
      }
    }
    const entries = [
      makeEntry('active', 'host-a', 'active', 1_000, now - 20 * day),
      makeEntry('expired', 'host-a', 'failed', 10, now - 7 * day),
      makeEntry('old-retained', 'host-a', 'cancelled', 80, now - 2 * day),
      makeEntry('new-retained', 'host-a', 'failed', 80, now - day),
      makeEntry('other-host', 'host-b', 'failed', 1_000, now - 20 * day)
    ]
    for (const entry of entries) await registry.upsert(entry)
    const unrelated = join(root, 'unregistered.part')
    writeFileSync(unrelated, 'must remain')

    const result = await registry.cleanupRetained({
      hostKey: 'host-a',
      freeBytes: 1_000,
      now,
      removeOwned: async (entry) => {
        unlinkSync(entry.partialLocator)
        unlinkSync(entry.manifestLocator)
      }
    })

    assert.deepEqual(new Set(result.removedTransferIds), new Set(['expired', 'old-retained']))
    assert.equal(result.quotaBytes, 100)
    assert.equal(result.retainedBytes, 80)
    assert.deepEqual(
      new Set((await registry.list()).map((entry) => entry.transferId)),
      new Set(['active', 'new-retained', 'other-host'])
    )
    assert.equal(readFileSync(unrelated, 'utf8'), 'must remain')
    assert.equal(existsSync(join(root, 'active.part')), true)
    assert.equal(existsSync(join(root, 'other-host.part')), true)
    assert.equal(statSync(registryPath).mode & 0o777, 0o600)

    const hardCap = await registry.cleanupRetained({
      hostKey: 'empty-host',
      freeBytes: 1024 * 1024 * 1024 * 1024,
      now,
      removeOwned: async () => assert.fail('empty host has no owned entries')
    })
    assert.equal(hardCap.quotaBytes, 20 * 1024 * 1024 * 1024)

    const runtimeRootCap = await registry.cleanupRetained({
      hostKey: 'empty-host',
      now,
      removeOwned: async () => assert.fail('empty host has no owned entries')
    })
    assert.ok(runtimeRootCap.quotaBytes > 0)
    assert.ok(runtimeRootCap.quotaBytes <= 20 * 1024 * 1024 * 1024)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('startup reconciliation turns prior-process active entries into retained failures', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-transfer-registry-reconcile-'))
  try {
    const registry = new FileTransferRegistry(join(root, 'registry.json'))
    await registry.upsert({
      transferId: 'interrupted',
      hostKey: 'host-a',
      cleanupOwner: 'test-owner',
      storageKey: 'test-storage',
      partialLocator: join(root, 'interrupted.part'),
      manifestLocator: join(root, 'interrupted.part.json'),
      status: 'active',
      retainedBytes: 42,
      createdAt: 100,
      updatedAt: 200
    })

    assert.equal(await registry.reconcileInterrupted(500), 1)
    assert.deepEqual(await registry.list(), [
      {
        transferId: 'interrupted',
        hostKey: 'host-a',
        cleanupOwner: 'test-owner',
        storageKey: 'test-storage',
        partialLocator: join(root, 'interrupted.part'),
        manifestLocator: join(root, 'interrupted.part.json'),
        status: 'failed',
        retainedBytes: 42,
        createdAt: 100,
        updatedAt: 500
      }
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cleanup isolates owners and storage domains and excludes queued resumptions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-transfer-registry-domain-'))
  try {
    const registry = new FileTransferRegistry(join(root, 'registry.json'))
    const now = 1_900_000_000_000
    const entries: TransferRegistryEntry[] = [
      {
        transferId: 'wrapper-expired',
        hostKey: 'host-a',
        cleanupOwner: 'wrapper-result',
        storageKey: 'local-device-1',
        partialLocator: 'wrapper.part',
        manifestLocator: 'wrapper.part.json',
        status: 'failed',
        retainedBytes: 10,
        createdAt: 1,
        updatedAt: 1
      },
      {
        transferId: 'wrapper-resuming',
        hostKey: 'host-a',
        cleanupOwner: 'wrapper-result',
        storageKey: 'local-device-1',
        partialLocator: 'resuming.part',
        manifestLocator: 'resuming.part.json',
        status: 'cancelled',
        retainedBytes: 10,
        createdAt: 1,
        updatedAt: 1
      },
      {
        transferId: 'remote-expired',
        hostKey: 'host-a',
        cleanupOwner: 'remote-http-direct',
        storageKey: 'remote-root-1',
        partialLocator: 'remote.part',
        manifestLocator: 'remote.part.json',
        status: 'failed',
        retainedBytes: 10,
        createdAt: 1,
        updatedAt: 1
      }
    ]
    for (const entry of entries) await registry.upsert(entry)
    const removed: string[] = []

    const result = await registry.cleanupRetained({
      hostKey: 'host-a',
      cleanupOwner: 'wrapper-result',
      storageKey: 'local-device-1',
      excludeTransferIds: new Set(['wrapper-resuming']),
      freeBytes: 1_000_000,
      now,
      removeOwned: async (entry) => removed.push(entry.transferId)
    })

    assert.deepEqual(removed, ['wrapper-expired'])
    assert.deepEqual(result.removedTransferIds, ['wrapper-expired'])
    assert.deepEqual(
      new Set((await registry.list()).map((entry) => entry.transferId)),
      new Set(['wrapper-resuming', 'remote-expired'])
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
