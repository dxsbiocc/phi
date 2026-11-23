import assert from 'node:assert/strict'
import test from 'node:test'

import type { JsonObject } from '../src/shared/notebookDocument'
import {
  notebookCellMetadataWithExecutionDuration,
  notebookDocumentMetadataWithExecutionEnvironment
} from '../src/shared/notebookExecutionMetadata'
import { notebookExecutionEnvironmentForKernel } from '../src/main/agent/notebook/analysis-kernels'

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

test('execution metadata records managed kernel envId and lockSha256 on cell and document', () => {
  const diagnostics = {
    jupyterServer: { available: true, command: 'jupyter' as const, managed: true },
    kernels: [
      {
        name: 'phi-python',
        displayName: 'Python 3.12 (phi-python)',
        language: 'python' as const,
        rawLanguage: 'python',
        source: 'managed' as const,
        status: 'ready' as const,
        environment: {
          ref: 'phi:python@1',
          envId: 'env_abc123',
          lockSha256: 'a'.repeat(64)
        }
      },
      {
        name: 'host-python3',
        displayName: 'Python 3 · host (unmanaged)',
        language: 'python' as const,
        rawLanguage: 'python',
        source: 'host' as const,
        status: 'ready' as const
      }
    ],
    hasPythonKernel: true,
    hasRKernel: false,
    messages: []
  }

  const managedEnv = notebookExecutionEnvironmentForKernel('phi-python', diagnostics)
  assert.deepEqual(managedEnv, {
    kernelName: 'phi-python',
    source: 'managed',
    ref: 'phi:python@1',
    envId: 'env_abc123',
    lockSha256: 'a'.repeat(64)
  })

  const cellMeta = notebookCellMetadataWithExecutionDuration({}, execution, managedEnv)
  assert.deepEqual((cellMeta.phi as JsonObject).executionEnvironment, {
    kernelName: 'phi-python',
    source: 'managed',
    ref: 'phi:python@1',
    envId: 'env_abc123',
    lockSha256: 'a'.repeat(64)
  })

  const docMeta = notebookDocumentMetadataWithExecutionEnvironment(
    { phi: { created_by: 'Phi analysis workbench' } },
    managedEnv!,
    execution.completedAt
  )
  assert.deepEqual(docMeta, {
    phi: {
      created_by: 'Phi analysis workbench',
      executionEnvironment: {
        kernelName: 'phi-python',
        source: 'managed',
        ref: 'phi:python@1',
        envId: 'env_abc123',
        lockSha256: 'a'.repeat(64),
        recordedAt: execution.completedAt
      }
    }
  })

  const hostEnv = notebookExecutionEnvironmentForKernel('host-python3', diagnostics)
  assert.deepEqual(hostEnv, {
    kernelName: 'host-python3',
    source: 'host'
  })
})
