import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  loadOfficeOperationLog,
  officeOperationDigest,
  persistOfficeOperationLog,
  pruneOfficeOperationLog,
  recordOfficeOperationPrewrite,
  startOfficeOperation,
  type OfficeOperationLogState
} from '../src/main/agent/office/office-operation-log'

test('Office operation digest is stable and preserves value types', () => {
  const ordered = {
    sheet: 'Sheet1',
    cell: 'A1',
    value: 1,
    baseRevision: 4
  }
  const reordered = {
    baseRevision: 4,
    value: 1,
    cell: 'A1',
    sheet: 'Sheet1'
  }

  assert.equal(officeOperationDigest(ordered), officeOperationDigest(reordered))
  assert.notEqual(officeOperationDigest(ordered), officeOperationDigest({ ...ordered, value: '1' }))
})

test('Office operation log atomically persists revision and receipts beside the draft', async () => {
  const artifactDir = await mkdtemp(join(tmpdir(), 'office-operation-log-save-'))
  const draftPath = join(artifactDir, 'draft.xlsx')
  const state: OfficeOperationLogState = {
    version: 2,
    contentRevision: 7,
    saveState: 'saved',
    lastSavedRevision: 7,
    lastSavedAt: '2026-10-05T00:00:01.000Z',
    savedDraftHash: 'b'.repeat(64),
    operations: {
      'tool-1': {
        digest: 'a'.repeat(64),
        status: 'succeeded',
        createdAt: '2026-10-05T00:00:00.000Z',
        receipt: {
          ok: true,
          value: {
            applied: true,
            saved: true,
            revision: 7,
            sheet: 'Sheet1',
            cell: 'A1',
            before: null,
            after: '实验编号',
            previewConfirmed: true
          }
        }
      }
    }
  }
  try {
    await writeFile(draftPath, 'draft')
    await persistOfficeOperationLog(draftPath, state, { randomId: () => 'test-write' })

    assert.deepEqual(await loadOfficeOperationLog(draftPath), state)
    const stored = JSON.parse(await readFile(join(artifactDir, 'operations.json'), 'utf8'))
    assert.equal(stored.version, 2)
    assert.match(stored.checksum, /^[a-f0-9]{64}$/u)
  } finally {
    await rm(artifactDir, { recursive: true, force: true })
  }
})

test('Office operation log v2 persists typed prewrite evidence before execution', async () => {
  const artifactDir = await mkdtemp(join(tmpdir(), 'office-operation-log-prewrite-'))
  const draftPath = join(artifactDir, 'draft.xlsx')
  const operation = { sheet: 'Sheet1', cell: 'A1', value: 1, baseRevision: 3 }
  const started = startOfficeOperation(
    { version: 2, contentRevision: 3, operations: {} },
    'tool-prewrite',
    officeOperationDigest(operation),
    '2026-10-05T00:00:00.000Z'
  )
  const state = recordOfficeOperationPrewrite(started, 'tool-prewrite', operation, '1')
  try {
    await writeFile(draftPath, 'draft')
    await persistOfficeOperationLog(draftPath, state)

    const loaded = await loadOfficeOperationLog(draftPath)
    assert.equal(loaded.version, 2)
    assert.deepEqual(loaded.operations['tool-prewrite'], {
      digest: officeOperationDigest(operation),
      status: 'in_flight',
      createdAt: '2026-10-05T00:00:00.000Z',
      operation,
      before: '1'
    })
    const stored = JSON.parse(await readFile(join(artifactDir, 'operations.json'), 'utf8'))
    assert.equal(stored.version, 2)
  } finally {
    await rm(artifactDir, { recursive: true, force: true })
  }
})

test('Office operation log upgrades a checksummed v1 in-flight record without inventing evidence', async () => {
  const artifactDir = await mkdtemp(join(tmpdir(), 'office-operation-log-v1-'))
  const draftPath = join(artifactDir, 'draft.xlsx')
  const body = {
    version: 1,
    contentRevision: 0,
    operations: {
      legacy: {
        digest: 'a'.repeat(64),
        status: 'in_flight',
        createdAt: '2026-10-05T00:00:00.000Z'
      }
    }
  }
  const checksum = createHash('sha256').update(JSON.stringify(body)).digest('hex')
  try {
    await writeFile(draftPath, 'draft')
    await writeFile(join(artifactDir, 'operations.json'), JSON.stringify({ ...body, checksum }))

    const loaded = await loadOfficeOperationLog(draftPath)

    assert.equal(loaded.version, 2)
    assert.equal(loaded.freezeState, 'unknown')
    assert.equal(loaded.operations.legacy.operation, undefined)
    assert.equal(loaded.operations.legacy.before, undefined)
  } finally {
    await rm(artifactDir, { recursive: true, force: true })
  }
})

test('Office operation log keeps the previous record when atomic rename fails', async () => {
  const artifactDir = await mkdtemp(join(tmpdir(), 'office-operation-log-rename-'))
  const draftPath = join(artifactDir, 'draft.xlsx')
  const initial: OfficeOperationLogState = { version: 2, contentRevision: 2, operations: {} }
  const updated: OfficeOperationLogState = { version: 2, contentRevision: 3, operations: {} }
  try {
    await writeFile(draftPath, 'draft')
    await persistOfficeOperationLog(draftPath, initial)

    await assert.rejects(
      persistOfficeOperationLog(draftPath, updated, {
        randomId: () => 'rename-failure',
        rename: async () => {
          throw new Error('/private/internal/rename failed')
        }
      }),
      /rename failed/u
    )

    assert.deepEqual(await loadOfficeOperationLog(draftPath), initial)
    await assert.rejects(readFile(join(artifactDir, 'operations.json.tmp-rename-failure')))
  } finally {
    await rm(artifactDir, { recursive: true, force: true })
  }
})

test('Office operation log treats an old draft without a log as revision zero', async () => {
  const artifactDir = await mkdtemp(join(tmpdir(), 'office-operation-log-old-'))
  const draftPath = join(artifactDir, 'draft.xlsx')
  try {
    await writeFile(draftPath, 'draft')
    await writeFile(join(artifactDir, 'operations.json.tmp-crashed'), '{not-json')

    const loaded = await loadOfficeOperationLog(draftPath)

    assert.equal(loaded.contentRevision, 0)
    assert.deepEqual(loaded.operations, {})
    assert.equal(loaded.freezeState, undefined)
  } finally {
    await rm(artifactDir, { recursive: true, force: true })
  }
})

test('Office operation log fails closed and backs up corrupt or unsupported records', async () => {
  const unsupported = { version: 99, contentRevision: 0, operations: {} }
  const invalidRecords = [
    '{not-json',
    JSON.stringify({
      ...unsupported,
      checksum: createHash('sha256').update(JSON.stringify(unsupported)).digest('hex')
    }),
    JSON.stringify({ version: 1, contentRevision: 0, operations: {}, checksum: '0'.repeat(64) })
  ]

  for (const [index, bytes] of invalidRecords.entries()) {
    const artifactDir = await mkdtemp(join(tmpdir(), `office-operation-log-corrupt-${index}-`))
    const draftPath = join(artifactDir, 'draft.xlsx')
    try {
      await writeFile(draftPath, 'draft')
      await writeFile(join(artifactDir, 'operations.json'), bytes)

      const loaded = await loadOfficeOperationLog(draftPath, { clock: () => 1_234 + index })

      assert.equal(loaded.integrityError, 'operation_log_corrupt')
      assert.equal(loaded.freezeState, 'unknown')
      assert.equal(await readFile(join(artifactDir, 'operations.json'), 'utf8'), bytes)
      const backups = (await readdir(artifactDir)).filter((name) =>
        name.startsWith('operations.json.corrupt-')
      )
      assert.deepEqual(backups, [`operations.json.corrupt-${1_234 + index}`])
      assert.equal(await readFile(join(artifactDir, backups[0]), 'utf8'), bytes)
    } finally {
      await rm(artifactDir, { recursive: true, force: true })
    }
  }
})

test('Office operation log backup failure reports only a safe corruption error', async () => {
  const artifactDir = await mkdtemp(join(tmpdir(), 'office-operation-log-backup-failure-'))
  const draftPath = join(artifactDir, 'draft.xlsx')
  try {
    await writeFile(draftPath, 'draft')
    await writeFile(join(artifactDir, 'operations.json'), '{not-json')

    await assert.rejects(
      loadOfficeOperationLog(draftPath, {
        copyFile: async () => {
          throw new Error('/private/internal/operations.json copy failed')
        }
      }),
      (error) => {
        assert.equal((error as { code?: unknown }).code, 'operation_log_corrupt')
        assert.doesNotMatch((error as Error).message, /private|operations\.json/u)
        return true
      }
    )
  } finally {
    await rm(artifactDir, { recursive: true, force: true })
  }
})

test('Office operation log prunes old terminal receipts but keeps in-flight and latest success', () => {
  const failureReceipt = {
    ok: false as const,
    error: { code: 'revision_conflict' as const }
  }
  const operations: Record<string, OfficeOperationLogState['operations'][string]> = {
    'latest-success': {
      digest: 'a'.repeat(64),
      status: 'succeeded',
      createdAt: '2026-01-01T00:00:00.000Z',
      receipt: {
        ok: true,
        value: {
          applied: true,
          saved: true,
          revision: 1,
          sheet: 'Sheet1',
          cell: 'A1',
          before: null,
          after: 'kept',
          previewConfirmed: true
        }
      }
    },
    'in-flight-old': {
      digest: 'b'.repeat(64),
      status: 'in_flight',
      createdAt: '2025-01-01T00:00:00.000Z'
    },
    'in-flight-new': {
      digest: 'c'.repeat(64),
      status: 'in_flight',
      createdAt: '2027-01-01T00:00:00.000Z'
    }
  }
  for (let index = 0; index < 501; index += 1) {
    operations[`failure-${String(index).padStart(3, '0')}`] = {
      digest: 'd'.repeat(64),
      status: 'failed',
      createdAt: new Date(Date.UTC(2026, 0, 2, 0, 0, index)).toISOString(),
      receipt: failureReceipt
    }
  }

  const pruned = pruneOfficeOperationLog({ version: 1, contentRevision: 1, operations })
  const terminal = Object.values(pruned.operations).filter((entry) => entry.status !== 'in_flight')

  assert.equal(terminal.length, 500)
  assert.ok(pruned.operations['latest-success'])
  assert.ok(pruned.operations['in-flight-old'])
  assert.ok(pruned.operations['in-flight-new'])
  assert.equal(pruned.operations['failure-000'], undefined)
  assert.ok(pruned.operations['failure-500'])
})
