import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import type { McpConnectorSetupProgress } from '../src/shared/mcpConnectorCatalog'
import {
  connectorJobDetail,
  connectorJobStatusLabel,
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
    '正在启动并验证 · 已用时 01:05'
  )
  assert.equal(
    connectorJobDetail(setup({ phase: 'ready', toolNames: ['one', 'two'] }), 0),
    '已完成 · 2 个工具'
  )
  assert.equal(
    connectorJobDetail(setup({ phase: 'failed', error: 'fixture failed' }), 0),
    '失败 · fixture failed'
  )
  assert.equal(connectorJobDetail(setup({ phase: 'failed', error: '已取消' }), 0), '已取消')
  const needsSetup = setup({
    phase: 'failed',
    failureKind: 'needs-setup',
    failureReason: 'Configuration file not found'
  })
  assert.equal(connectorJobDetail(needsSetup, 0), '需要先配置 · Configuration file not found')
  assert.equal(connectorJobStatusLabel(needsSetup), '需要先配置')
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
  assert.match(labels, /取消添加/)
  assert.match(labels, /连接器/)
  assert.match(row, /重试/)
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
  assert.match(row, /aria-label=\{`查看 \$\{title\} 详情`\}/)
  assert.match(row, /event\.stopPropagation\(\)/)
  assert.match(row, /overflowWrap: 'anywhere'/)
  assert.match(row, /WebkitLineClamp: 2/)
  assert.match(row, /failureKind === 'needs-setup'[\s\S]*?warning\.main/)
})
