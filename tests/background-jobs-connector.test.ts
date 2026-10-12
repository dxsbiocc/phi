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
  const source = readFileSync('src/renderer/src/features/jobs/BackgroundJobsPanel.tsx', 'utf8')
  assert.match(source, /listLocalConnectorJobs/)
  assert.match(source, /onMcpConnectorSetupChanged/)
  assert.match(source, /cancelLocalConnectorAdd/)
  assert.match(source, /retryLocalConnectorAdd/)
  assert.match(source, /取消添加/)
  assert.match(source, /连接器/)
  assert.match(source, /重试/)
  assert.match(source, /ConnectorJobDetailDialog/)
  assert.match(source, /requestedConnectorJobId/)
  assert.match(source, /onRequestedConnectorJobHandled/)
  assert.match(source, /role=\{item\.kind === 'connector' \? 'button' : undefined\}/)
  assert.match(source, /tabIndex=\{item\.kind === 'connector' \? 0 : undefined\}/)
  assert.match(source, /event\.key === 'Enter' \|\| event\.key === ' '/)
  assert.match(source, /event\.currentTarget !== event\.target/)
  assert.match(
    source,
    /aria-label=\{item\.kind === 'connector' \? `查看 \$\{title\} 详情` : undefined\}/
  )
  assert.match(source, /event\.stopPropagation\(\)/)
  assert.match(source, /overflowWrap: 'anywhere'/)
  assert.match(source, /WebkitLineClamp: 2/)
  assert.match(source, /failureKind === 'needs-setup'[\s\S]*?warning\.main/)
})
