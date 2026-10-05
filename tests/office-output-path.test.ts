import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  appendOfficeOutputRecord,
  persistOfficeOutputLog
} from '../src/main/agent/office/office-output-log'
import { resolveRecordedOfficeOutput } from '../src/main/agent/office/office-output-path'

test('a recorded Office output reopens after restart only while its hash still matches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-output-path-'))
  const artifact = join(root, 'artifact')
  const draftPath = join(artifact, 'draft.xlsx')
  const outputPath = join(root, 'report.xlsx')
  const bytes = Buffer.from('immutable office output')
  try {
    await mkdir(artifact)
    await writeFile(draftPath, 'draft')
    await writeFile(outputPath, bytes)
    const state = appendOfficeOutputRecord(
      { version: 1, outputs: [] },
      {
        outputId: 'output-1',
        outputPath: 'report.xlsx',
        revision: 2,
        sha256: digest(bytes),
        size: bytes.length,
        createdAt: '2026-10-05T12:00:00.000Z',
        source: 'draft'
      }
    )
    await persistOfficeOutputLog(draftPath, state)

    assert.equal((await resolveRecordedOfficeOutput(draftPath, root, 'output-1')).path, outputPath)
    await writeFile(outputPath, 'changed')
    await assert.rejects(resolveRecordedOfficeOutput(draftPath, root, 'output-1'), {
      code: 'output_integrity_failed'
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a recorded Office output never follows a replacement symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-output-symlink-'))
  const artifact = join(root, 'artifact')
  const draftPath = join(artifact, 'draft.xlsx')
  const outside = join(root, '..', `outside-${Date.now()}.xlsx`)
  try {
    await mkdir(artifact)
    await writeFile(draftPath, 'draft')
    await writeFile(outside, 'outside')
    await symlink(outside, join(root, 'report.xlsx'))
    const bytes = Buffer.from('outside')
    const state = appendOfficeOutputRecord(
      { version: 1, outputs: [] },
      {
        outputId: 'output-1',
        outputPath: 'report.xlsx',
        revision: 1,
        sha256: digest(bytes),
        size: bytes.length,
        createdAt: '2026-10-05T12:00:00.000Z',
        source: 'draft'
      }
    )
    await persistOfficeOutputLog(draftPath, state)

    await assert.rejects(resolveRecordedOfficeOutput(draftPath, root, 'output-1'))
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { force: true })
  }
})

test('a recorded empty CSV export resolves after restart with its v3 metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-output-csv-'))
  const artifact = join(root, 'artifact')
  const draftPath = join(artifact, 'draft.xlsx')
  const outputPath = join(root, 'draft-Sheet1.csv')
  const bytes = Buffer.alloc(0)
  try {
    await mkdir(artifact)
    await writeFile(draftPath, 'draft')
    await writeFile(outputPath, bytes)
    const state = appendOfficeOutputRecord(
      { version: 1, outputs: [] },
      {
        outputId: 'export-1',
        outputPath: 'draft-Sheet1.csv',
        revision: 0,
        sha256: digest(bytes),
        size: 0,
        createdAt: '2026-10-06T00:00:00.000Z',
        source: 'draft',
        requestId: 'request-1',
        requestDigest: 'd'.repeat(64),
        format: 'csv',
        sheet: 'Sheet1',
        rows: 0,
        columns: 0
      }
    )
    await persistOfficeOutputLog(draftPath, state)

    const resolved = await resolveRecordedOfficeOutput(draftPath, root, 'export-1')
    assert.equal(resolved.path, outputPath)
    assert.equal('format' in resolved.record && resolved.record.format, 'csv')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}
