import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
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

async function checkpoint(
  root: string,
  transferId: string
): Promise<
  Readonly<{
    registry: FileTransferRegistry
    request: TransferRequest
    part: string
    manifestPath: string
  }>
> {
  const source = join(root, 'source.bin')
  const destination = join(root, 'saved.bin')
  writeFileSync(source, Buffer.alloc(3 * 1024 * 1024, 0x4a))
  const registry = new FileTransferRegistry(join(root, 'registry.json'))
  const manager = new FileTransferManager({
    registry,
    dataPlanes: [new LocalTransferDataPlane()],
    policy: {
      chunkSizeBytes: 1024 * 1024,
      checkpointBytes: 1024 * 1024,
      progressBytes: 1,
      progressIntervalMs: 0
    },
    onEvent: (event) => {
      if (event.state === 'transferring' && event.bytesTransferred >= 1024 * 1024) handle.cancel()
    }
  })
  const request: TransferRequest = {
    transferId,
    direction: 'local',
    hostKey: 'local',
    dataPlaneId: 'local',
    source: { kind: 'local-path', path: source },
    destination: { kind: 'local-path', path: destination }
  }
  const handle = manager.enqueue(request)
  await assert.rejects(handle.completion, { code: 'ABORTED' })
  const part = join(root, `.saved.bin.phi-transfer-${transferId}.part`)
  return { registry, request, part, manifestPath: `${part}.json` }
}

function resume(
  fixture: Awaited<ReturnType<typeof checkpoint>>,
  plane: TransferDataPlane = new LocalTransferDataPlane()
): Promise<unknown> {
  return new FileTransferManager({
    registry: fixture.registry,
    dataPlanes: [plane],
    policy: { chunkSizeBytes: 1024 * 1024, checkpointBytes: 1024 * 1024 }
  }).enqueue(fixture.request).completion
}

test('resume rejects a directory where a regular partial is required', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-transfer-part-type-'))
  try {
    const fixture = await checkpoint(root, 'wrong-type')
    unlinkSync(fixture.part)
    mkdirSync(fixture.part)
    await assert.rejects(resume(fixture), { code: 'INVALID_PARTIAL' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resume rejects a partial shorter than the durable offset', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-transfer-part-size-'))
  try {
    const fixture = await checkpoint(root, 'wrong-size')
    const manifest = JSON.parse(readFileSync(fixture.manifestPath, 'utf8')) as {
      durableOffset: number
    }
    truncateSync(fixture.part, manifest.durableOffset - 1)
    await assert.rejects(resume(fixture), { code: 'INVALID_PARTIAL' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resume rejects a manifest that does not match the transfer contract', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-transfer-manifest-mismatch-'))
  try {
    const fixture = await checkpoint(root, 'manifest-mismatch')
    const manifest = JSON.parse(readFileSync(fixture.manifestPath, 'utf8')) as Record<
      string,
      unknown
    >
    writeFileSync(fixture.manifestPath, JSON.stringify({ ...manifest, direction: 'upload' }))
    await assert.rejects(resume(fixture), { code: 'INVALID_MANIFEST' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resume refuses a symbolic-link manifest', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-transfer-manifest-symlink-'))
  try {
    const fixture = await checkpoint(root, 'manifest-symlink')
    unlinkSync(fixture.manifestPath)
    symlinkSync((fixture.request.source as { path: string }).path, fixture.manifestPath)
    await assert.rejects(resume(fixture), { code: 'INVALID_MANIFEST' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resume rejects a partial owned by another runtime identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-transfer-part-owner-'))
  try {
    const fixture = await checkpoint(root, 'wrong-owner')
    const local = new LocalTransferDataPlane()
    const wrongOwnerPlane: TransferDataPlane = {
      id: 'local',
      destinationKey: (request) => local.destinationKey(request),
      open: async (request): Promise<TransferDataPlaneSession> => {
        const session = await local.open(request)
        return new Proxy(session, {
          get(target, property, receiver) {
            if (property === 'inspectPartial') {
              return async () => ({
                ...(await target.inspectPartial()),
                ownerId: (typeof process.getuid === 'function' ? process.getuid() : 0) + 1
              })
            }
            const value = Reflect.get(target, property, receiver) as unknown
            return typeof value === 'function' ? value.bind(target) : value
          }
        })
      }
    }
    await assert.rejects(resume(fixture, wrongOwnerPlane), { code: 'INVALID_PARTIAL' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
