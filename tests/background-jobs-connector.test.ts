import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { jobStatus } from '../src/renderer/src/features/jobs/lib/backgroundJobLabels'
import type { McpConnectorSetupProgress } from '../src/shared/mcpConnectorCatalog'
import {
  connectorJobDetail,
  connectorJobStatusLabel,
  isCancelledConnectorJob,
  selectBackgroundJobs
} from '../src/renderer/src/features/jobs/lib/backgroundJobs'

function setup(overrides: Partial<McpConnectorSetupProgress> = {}): McpConnectorSetupProgress {
  return {
    id: 'mail',
    kind: 'local-stdio',
    title: 'mail',
    summary: 'bun x --bun qq-email-mcp@0.1.1',
    startedAt: '2026-10-11T08:00:00.000Z',
    phase: 'starting',
    revision: 1,
    updatedAt: '2026-10-11T08:00:00.000Z',
    ...overrides
  }
}

test('connector jobs join the unified active and recent trays', () => {
  const result = selectBackgroundJobs(
    [],
    [],
    {},
    [],
    [],
    [
      setup(),
      setup({
        id: 'done',
        title: 'done',
        phase: 'ready',
        revision: 2,
        updatedAt: '2026-10-11T08:01:00.000Z',
        toolNames: ['one', 'two']
      }),
      setup({ id: 'package-record', kind: undefined })
    ]
  )
  assert.deepEqual(
    result.active.map(({ key }) => key),
    ['connector:mail']
  )
  assert.deepEqual(
    result.recent.map(({ key }) => key),
    ['connector:done']
  )
  assert.equal(result.active[0]?.kind, 'connector')
  assert.equal(result.active[0]?.active, true)
})

test('connector job labels show elapsed time, tools, failures, and cancellation', () => {
  assert.equal(
    connectorJobDetail(setup(), Date.parse('2026-10-11T08:01:05.000Z')),
    'Starting and verifying · 01:05 elapsed'
  )
  assert.equal(
    connectorJobDetail(setup({ phase: 'ready', toolNames: ['one', 'two'] }), 0),
    'Completed · 2 tools'
  )
  assert.equal(
    connectorJobDetail(setup({ phase: 'failed', error: 'fixture failed' }), 0),
    'Failed · fixture failed'
  )
  for (const error of ['已取消', 'Cancelled']) {
    const cancelled = setup({ phase: 'failed', error })
    assert.equal(isCancelledConnectorJob(cancelled), true)
    assert.equal(connectorJobDetail(cancelled, 0), 'Cancelled')
    assert.equal(connectorJobStatusLabel(cancelled), 'Cancelled')
    assert.deepEqual(
      jobStatus({
        kind: 'connector',
        key: 'connector:mail',
        active: false,
        timestamp: cancelled.updatedAt,
        setup: cancelled
      }),
      { label: 'Cancelled', tone: 'neutral' }
    )
  }
  const needsSetup = setup({
    phase: 'failed',
    failureKind: 'needs-setup',
    failureReason: 'Configuration file not found'
  })
  assert.equal(connectorJobDetail(needsSetup, 0), 'Setup required · Configuration file not found')
  assert.equal(connectorJobStatusLabel(needsSetup), 'Setup required')
})

test('background jobs panel wires connector polling, events, cancel, retry, and display copy', () => {
  const panel = readFileSync('src/renderer/src/features/jobs/BackgroundJobsPanel.tsx', 'utf8')
  const data = readFileSync('src/renderer/src/features/jobs/hooks/useBackgroundJobsData.ts', 'utf8')
  const row = readFileSync('src/renderer/src/features/jobs/components/BackgroundJobRow.tsx', 'utf8')
  const labels = readFileSync('src/renderer/src/features/jobs/lib/backgroundJobLabels.ts', 'utf8')
  assert.match(data, /listLocalConnectorJobs/)
  assert.match(data, /onMcpConnectorSetupChanged/)
  assert.match(panel, /cancelLocalConnectorAdd/)
  assert.match(panel, /retryLocalConnectorAdd/)
  assert.match(labels, /connectorJobCopy\.cancelAdd/)
  assert.match(labels, /resourceUi\.connector/)
  assert.match(row, /jobsCopy.retry/)
  // Connector details open inside the panel instead of a modal dialog.
  assert.match(panel, /BackgroundJobDetail/)
  assert.doesNotMatch(panel, /ConnectorJobDetailDialog/)
  assert.match(panel, /requestedConnectorJobId/)
  assert.match(panel, /onRequestedConnectorJobHandled/)
  // Every row opens its detail, by mouse or keyboard, while row buttons keep their own action.
  assert.match(row, /role="button"/)
  assert.match(row, /tabIndex=\{0\}/)
  assert.match(row, /event\.key === 'Enter' \|\| event\.key === ' '/)
  assert.match(row, /event\.currentTarget !== event\.target/)
  assert.match(row, /aria-label=\{jobsCopy.viewDetailsForValue\(title\)\}/)
  assert.match(row, /event\.stopPropagation\(\)/)
  assert.match(row, /overflowWrap: 'anywhere'/)
  assert.match(row, /WebkitLineClamp: 2/)
  assert.match(row, /failureKind === 'needs-setup'[\s\S]*?warning\.main/)
})
