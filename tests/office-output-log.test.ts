import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  appendOfficeOutputRecord,
  loadOfficeOutputLog,
  persistOfficeOutputLog,
  type OfficeDeliveryOutputRecord,
  type OfficeExportOutputRecord,
  type OfficeOutputLogState,
  type OfficeOutputRecord
} from '../src/main/agent/office/office-output-log'

function record(index: number, extension: 'xlsx' | 'docx' | 'pptx' = 'xlsx'): OfficeOutputRecord {
  return {
    outputId: `output-${index}`,
    outputPath: `outputs/office/report-${index}.${extension}`,
    revision: index,
    sha256: index.toString(16).padStart(64, '0'),
    size: 100 + index,
    createdAt: new Date(Date.UTC(2026, 9, 5, 0, 0, index)).toISOString(),
    source: 'draft'
  }
}

function exportRecord(index: number, format: 'csv' | 'tsv'): OfficeExportOutputRecord {
  return {
    ...record(index),
    outputPath: `outputs/office/report-${index}.${format}`,
    size: index === 0 ? 0 : 100 + index,
    requestId: `export-${index}`,
    requestDigest: 'c'.repeat(64),
    format,
    sheet: '数据 表',
    rows: index,
    columns: index === 0 ? 0 : 3
  }
}

test('output log atomically round-trips a project-relative immutable output record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-output-log-'))
  const draftPath = join(root, 'draft.xlsx')
  try {
    await writeFile(draftPath, 'draft')
    const state = appendOfficeOutputRecord({ version: 1, outputs: [] }, record(1))
    await persistOfficeOutputLog(draftPath, state, { randomId: () => 'test' })

    assert.deepEqual(await loadOfficeOutputLog(draftPath), state)
    const stored = JSON.parse(await readFile(join(root, 'outputs.json'), 'utf8'))
    assert.equal(stored.version, 1)
    assert.match(stored.checksum, /^[a-f0-9]{64}$/u)
    assert.deepEqual(await readdir(root), ['draft.xlsx', 'outputs.json'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('output log restores docx output records without changing the legacy schema', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-output-log-docx-'))
  const draftPath = join(root, 'draft.docx')
  try {
    await writeFile(draftPath, 'draft')
    const state = appendOfficeOutputRecord({ version: 1, outputs: [] }, record(1, 'docx'))
    await persistOfficeOutputLog(draftPath, state, { randomId: () => 'test' })

    assert.deepEqual(await loadOfficeOutputLog(draftPath), state)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('output log restores pptx output records without changing the legacy schema', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-output-log-pptx-'))
  const draftPath = join(root, 'draft.pptx')
  try {
    await writeFile(draftPath, 'draft')
    const state = appendOfficeOutputRecord({ version: 1, outputs: [] }, record(1, 'pptx'))
    await persistOfficeOutputLog(draftPath, state, { randomId: () => 'test' })

    assert.deepEqual(await loadOfficeOutputLog(draftPath), state)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('output log corruption fails closed and record pruning never deletes user files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-output-log-corrupt-'))
  const draftPath = join(root, 'draft.xlsx')
  try {
    await writeFile(draftPath, 'draft')
    await writeFile(join(root, 'outputs.json'), '{bad-json')
    await assert.rejects(loadOfficeOutputLog(draftPath), { code: 'output_log_corrupt' })

    let state: OfficeOutputLogState = { version: 1, outputs: [] }
    for (let index = 0; index < 105; index += 1) {
      state = appendOfficeOutputRecord(state, record(index))
    }
    assert.equal(state.outputs.length, 100)
    assert.equal(state.outputs[0]?.outputId, 'output-5')
    assert.equal((await readdir(root)).includes('draft.xlsx'), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a delivery upgrades a legacy v1 log while preserving old output records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-output-log-delivery-'))
  const draftPath = join(root, 'draft.xlsx')
  const delivered: OfficeDeliveryOutputRecord = {
    ...record(2),
    operationId: 'tool-call-2',
    requestDigest: 'a'.repeat(64),
    kind: 'xlsx',
    checks: [
      { name: 'schema', status: 'passed' },
      { name: 'xlsx_content', status: 'passed', sampled: 1 }
    ],
    warnings: []
  }
  try {
    await writeFile(draftPath, 'draft')
    const legacy = appendOfficeOutputRecord({ version: 1, outputs: [] }, record(1))
    await persistOfficeOutputLog(draftPath, legacy)

    const upgraded = appendOfficeOutputRecord(await loadOfficeOutputLog(draftPath), delivered)
    await persistOfficeOutputLog(draftPath, upgraded)

    assert.equal(upgraded.version, 2)
    assert.deepEqual(await loadOfficeOutputLog(draftPath), upgraded)
    assert.deepEqual(upgraded.outputs, [record(1), delivered])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ordinary Save As pruning never removes durable delivery identities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-output-log-durable-delivery-'))
  const draftPath = join(root, 'draft.xlsx')
  const delivery: OfficeDeliveryOutputRecord = {
    ...record(500),
    outputId: 'delivery-500',
    operationId: 'tool-call-500',
    requestDigest: 'b'.repeat(64),
    kind: 'xlsx',
    checks: [
      { name: 'schema', status: 'passed' },
      { name: 'xlsx_content', status: 'passed', sampled: 1 }
    ],
    warnings: []
  }
  const exported: OfficeExportOutputRecord = {
    ...exportRecord(600, 'csv'),
    outputId: 'export-600',
    requestId: 'export-request-600'
  }
  try {
    await writeFile(draftPath, 'draft')
    let state = appendOfficeOutputRecord({ version: 1, outputs: [] }, delivery)
    state = appendOfficeOutputRecord(state, exported)
    for (let index = 0; index < 105; index += 1) {
      state = appendOfficeOutputRecord(state, record(index))
    }
    await persistOfficeOutputLog(draftPath, state)
    const restored = await loadOfficeOutputLog(draftPath)

    assert.equal(
      restored.outputs.filter((entry) => !('operationId' in entry) && !('requestId' in entry))
        .length,
      100
    )
    assert.equal(
      restored.outputs.some((entry) => entry.outputId === delivery.outputId),
      true
    )
    assert.equal(
      restored.outputs.some((entry) => entry.outputId === exported.outputId),
      true
    )
    assert.throws(() =>
      appendOfficeOutputRecord(restored, { ...delivery, outputId: 'delivery-copy' })
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an export upgrades old logs to v3 and round-trips CSV/TSV metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-output-log-export-'))
  const draftPath = join(root, 'draft.xlsx')
  try {
    await writeFile(draftPath, 'draft')
    const legacy = appendOfficeOutputRecord({ version: 1, outputs: [] }, record(1))
    const csv = exportRecord(2, 'csv')
    const tsv = exportRecord(0, 'tsv')
    let state = appendOfficeOutputRecord(legacy, csv)
    state = appendOfficeOutputRecord(state, tsv)
    await persistOfficeOutputLog(draftPath, state)

    assert.equal(state.version, 3)
    assert.deepEqual(await loadOfficeOutputLog(draftPath), state)
    assert.deepEqual(state.outputs, [record(1), csv, tsv])
    assert.throws(() => appendOfficeOutputRecord(state, { ...csv, outputId: 'duplicate-request' }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
