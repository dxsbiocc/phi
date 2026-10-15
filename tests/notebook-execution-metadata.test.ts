import assert from 'node:assert/strict'
import test from 'node:test'

import type { JsonObject } from '../src/shared/notebookDocument'
import { notebookCellMetadataWithExecutionDuration } from '../src/shared/notebookExecutionMetadata'

const execution = {
  startedAt: '2026-10-15T02:03:04.000Z',
  completedAt: '2026-10-15T02:03:05.530Z'
}

test('execution metadata preserves notebook fields and replaces only previous execution timing', () => {
  const metadata: JsonObject = {
    tags: ['analysis'],
    collapsed: true,
    phi: {
      custom: { retained: true },
      executionStartedAt: '2026-10-14T02:03:04.000Z',
      executionCompletedAt: '2026-10-14T02:03:08.000Z',
      executionDurationMs: 4000
    }
  }
  const original = structuredClone(metadata)

  const result = notebookCellMetadataWithExecutionDuration(metadata, execution)

  assert.deepEqual(result, {
    tags: ['analysis'],
    collapsed: true,
    phi: {
      custom: { retained: true },
      executionStartedAt: execution.startedAt,
      executionCompletedAt: execution.completedAt,
      executionDurationMs: 1530
    }
  })
  assert.deepEqual(metadata, original)
  assert.notEqual(result, metadata)
  assert.notEqual(result.phi, metadata.phi)
})

test('execution metadata handles missing and non-object Phi metadata', () => {
  const metadataValues: JsonObject[] = [{}, { phi: null }, { phi: [] }, { phi: 'legacy' }]
  for (const metadata of metadataValues) {
    assert.deepEqual(notebookCellMetadataWithExecutionDuration(metadata, execution), {
      phi: {
        executionStartedAt: execution.startedAt,
        executionCompletedAt: execution.completedAt,
        executionDurationMs: 1530
      }
    })
  }
})

test('execution metadata clamps reversed timestamps to zero duration', () => {
  const result = notebookCellMetadataWithExecutionDuration(
    {},
    {
      startedAt: execution.completedAt,
      completedAt: execution.startedAt
    }
  )

  assert.equal((result.phi as JsonObject).executionDurationMs, 0)
})

test('execution metadata retains invalid timestamps with zero duration', () => {
  for (const timestamps of [
    { startedAt: 'invalid', completedAt: execution.completedAt },
    { startedAt: execution.startedAt, completedAt: 'invalid' },
    { startedAt: '', completedAt: '' }
  ]) {
    assert.deepEqual(notebookCellMetadataWithExecutionDuration({}, timestamps), {
      phi: {
        executionStartedAt: timestamps.startedAt,
        executionCompletedAt: timestamps.completedAt,
        executionDurationMs: 0
      }
    })
  }
})
