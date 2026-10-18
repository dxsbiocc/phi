import { beforeEach, afterEach } from 'node:test'
import { setUiLanguage } from '../src/renderer/src/lib/i18n'

// Keep these legacy behavioral assertions explicit about their presentation language.
beforeEach(() => setUiLanguage('zh-CN'))
afterEach(() => setUiLanguage('en'))

import assert from 'node:assert/strict'
import test from 'node:test'

import type { EnvironmentSnapshot, ManagedEnvironmentEntry } from '../src/shared/environmentTypes'
import {
  buildEnvironmentSections,
  formatBuildEstimate,
  formatEnvironmentSize,
  managedEnvironmentHostResources,
  managedEnvironmentSourceLabel,
  managedEnvironmentStateLabel
} from '../src/renderer/src/features/environment/lib/environmentPanel'

function managed(overrides: Partial<ManagedEnvironmentEntry>): ManagedEnvironmentEntry {
  return {
    ref: 'phi:python@1',
    envId: 'phi-python-123456789abc',
    state: 'absent',
    source: 'official',
    referrers: [],
    consumers: [],
    ...overrides
  }
}

test('builds one environment section and sorts managed sources', () => {
  const snapshot: EnvironmentSnapshot = {
    scannedAt: '2026-10-01T00:00:00.000Z',
    firstScanCompleted: true,
    summaryDismissed: true,
    tools: [],
    hostDependencies: [
      { id: 'docker', label: 'Docker', status: 'ready', path: '/usr/local/bin/docker' }
    ],
    hostTools: [
      {
        id: 'nextflow',
        label: 'Nextflow',
        status: 'not-configured',
        management: 'host-unmanaged',
        selected: false
      }
    ]
  }
  const sections = buildEnvironmentSections([
    managed({ ref: 'project:python-x1', source: 'project' }),
    managed({ ref: 'plugin:demo', source: 'plugin' }),
    managed({ ref: 'orphan:old', source: 'orphaned' }),
    managed({ ref: 'phi:python@1', source: 'official' })
  ])

  assert.deepEqual(
    sections.map((section) => section.title),
    ['环境']
  )
  assert.deepEqual(
    sections[0].items.map((entry) => entry.ref),
    ['phi:python@1', 'plugin:demo', 'project:python-x1', 'orphan:old']
  )
  const nextflowResources = managedEnvironmentHostResources(
    managed({ ref: 'phi:nextflow@1' }),
    snapshot
  )
  assert.deepEqual(
    nextflowResources.dependencies.map((item) => item.label),
    ['Docker']
  )
  assert.deepEqual(
    nextflowResources.tools.map((item) => item.label),
    ['Nextflow']
  )
})

test('legacy snapshot host detection is merged into its matching environment', () => {
  const snapshot = {
    scannedAt: '2026-10-01T00:00:00.000Z',
    firstScanCompleted: true,
    summaryDismissed: true,
    tools: [
      { id: 'micromamba', label: 'Conda', status: 'ready', source: 'detected' },
      { id: 'rscript', label: 'Rscript', status: 'ready', source: 'detected' },
      { id: 'docker', label: 'Docker', status: 'missing', source: 'none' },
      { id: 'nextflow', label: 'Nextflow', status: 'ready', source: 'custom' },
      { id: 'jupyter', label: 'Jupyter', status: 'missing', source: 'none' }
    ]
  } as EnvironmentSnapshot
  const nextflowResources = managedEnvironmentHostResources(
    managed({ ref: 'phi:nextflow@1' }),
    snapshot
  )
  const jupyterResources = managedEnvironmentHostResources(
    managed({ ref: 'phi:jupyter@1' }),
    snapshot
  )
  const pythonResources = managedEnvironmentHostResources(
    managed({ ref: 'phi:python@1' }),
    snapshot
  )

  assert.deepEqual(
    nextflowResources.dependencies.map((item) => item.label),
    ['Docker']
  )
  assert.deepEqual(
    nextflowResources.tools.map((item) => item.label),
    ['Nextflow']
  )
  assert.deepEqual(
    jupyterResources.tools.map((item) => item.label),
    ['Jupyter']
  )
  assert.deepEqual(pythonResources, { dependencies: [], tools: [] })
})

test('formats states, sources, sizes and estimates for Chinese UI copy', () => {
  assert.equal(managedEnvironmentStateLabel('drifted'), '需要修复')
  assert.equal(managedEnvironmentSourceLabel('orphaned'), '孤立环境')
  assert.equal(formatEnvironmentSize(undefined), '未知')
  assert.equal(formatEnvironmentSize(0), '0 B')
  assert.equal(formatEnvironmentSize(1536), '1.5 KB')
  assert.equal(formatEnvironmentSize(12 * 1024 ** 2), '12 MB')
  assert.equal(
    formatBuildEstimate({ packages: 8, cachedPackages: 3, remainingBytes: 512 * 1024 ** 2 }),
    '预计下载 512 MB · 8 个包（3 个已缓存）'
  )
  assert.equal(
    formatBuildEstimate({ packages: 8, cachedPackages: 8, remainingBytes: 0 }),
    '无需下载 · 8 个包（8 个已缓存）'
  )
})
