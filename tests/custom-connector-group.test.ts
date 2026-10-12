import assert from 'node:assert/strict'
import test from 'node:test'

import {
  customConnectorEntries,
  customConnectorReadySwitchKey,
  mergeCustomConnectorJobs
} from '../src/renderer/src/features/mcp/lib/customConnectorGroup'
import type { McpConnectorSetupProgress } from '../src/shared/mcpConnectorCatalog'
import type { McpServerSummary } from '../src/renderer/src/types'

function server(overrides: Partial<McpServerSummary> = {}): McpServerSummary {
  return {
    id: 'local-fixture',
    name: 'local-fixture',
    command: 'bun',
    args: ['run', 'server.ts'],
    envKeys: ['SECRET_TOKEN'],
    userStdio: true,
    enabled: true,
    status: 'configured',
    ...overrides
  }
}

function job(
  id: string,
  overrides: Partial<McpConnectorSetupProgress> = {}
): McpConnectorSetupProgress {
  return {
    id,
    kind: 'local-stdio',
    title: id,
    summary: `bun run ${id}.ts`,
    phase: 'starting',
    revision: 1,
    updatedAt: '2026-10-12T08:00:00.000Z',
    ...overrides
  }
}

test('presents a user stdio connector without exposing environment values', () => {
  const [entry] = customConnectorEntries([server()], [])

  assert.equal(entry?.kind, 'server')
  if (entry?.kind !== 'server') return
  assert.equal(entry.name, 'local-fixture')
  assert.equal(entry.subtitle, 'bun run server.ts')
  assert.equal(entry.origin, '自建·本地')
  assert.equal(entry.enabled, true)
  assert.deepEqual(entry.server.envKeys, ['SECRET_TOKEN'])
  assert.doesNotMatch(JSON.stringify(entry), /secret-value/i)
})

test('includes only remote connectors that are neither package-owned nor catalog-matched', () => {
  const entries = customConnectorEntries(
    [
      server({
        id: 'remote-custom',
        name: 'Remote Custom',
        command: undefined,
        args: undefined,
        envKeys: undefined,
        userStdio: undefined,
        url: 'https://custom.example/mcp'
      }),
      server({
        id: 'package-owned',
        userStdio: undefined,
        url: 'https://package.example/mcp',
        packageId: 'package-owned'
      }),
      server({
        id: 'catalog-match',
        userStdio: undefined,
        url: 'https://catalog.example/mcp',
        connectorId: 'catalog-entry'
      }),
      server({ id: 'plain-config', userStdio: undefined, command: 'node', url: undefined })
    ],
    []
  )

  assert.deepEqual(
    entries.map((entry) => [entry.name, entry.subtitle, entry.origin]),
    [['Remote Custom', 'https://custom.example/mcp', '自建·远程']]
  )
})

test('presents pending local jobs with setup-aware status labels', () => {
  const entries = customConnectorEntries(
    [],
    [
      job('starting'),
      job('needs-setup', { phase: 'failed', failureKind: 'needs-setup' }),
      job('failed', { phase: 'failed', failureKind: 'generic' }),
      job('ready', { phase: 'ready' }),
      job('package-job', { kind: undefined })
    ]
  )

  assert.deepEqual(
    entries.map((entry) => [entry.kind, entry.name, entry.status]),
    [
      ['job', 'failed', '添加失败'],
      ['job', 'needs-setup', '需要先配置'],
      ['job', 'starting', '正在添加…']
    ]
  )
})

test('merges local setup snapshots by revision without letting stale reads win', () => {
  const current = [job('mail', { revision: 3, phase: 'failed' })]
  const merged = mergeCustomConnectorJobs(current, [
    job('mail', { revision: 2 }),
    job('newer', { revision: 4 })
  ])

  assert.notEqual(merged, current)
  assert.equal(merged.find((entry) => entry.id === 'mail')?.revision, 3)
  assert.equal(merged.find((entry) => entry.id === 'newer')?.revision, 4)
  assert.equal(current.length, 1)
})

test('ready setup events request one list-page switch key but never switch a detail page', () => {
  const ready = job('mail', { phase: 'ready', revision: 5 })

  assert.equal(customConnectorReadySwitchKey(ready, 'list'), 'mail:5')
  assert.equal(customConnectorReadySwitchKey(ready, 'detail'), null)
  assert.equal(customConnectorReadySwitchKey(job('mail'), 'list'), null)
  assert.equal(customConnectorReadySwitchKey(job('mail', { kind: undefined }), 'list'), null)
})

test('orders newest jobs before name-sorted servers and hides a job after its server appears', () => {
  const entries = customConnectorEntries(
    [
      server({ id: 'zeta', name: 'Zeta' }),
      server({ id: 'alpha', name: 'Alpha' }),
      server({ id: 'finished', name: 'finished' })
    ],
    [
      job('older', { updatedAt: '2026-10-12T08:00:00.000Z' }),
      job('newer', { updatedAt: '2026-10-12T09:00:00.000Z' }),
      job('finished', { updatedAt: '2026-10-12T10:00:00.000Z' })
    ]
  )

  assert.deepEqual(
    entries.map((entry) => entry.name),
    ['newer', 'older', 'Alpha', 'finished', 'Zeta']
  )
  assert.equal(
    entries.filter((entry) => entry.kind === 'job' && entry.name === 'finished').length,
    0
  )
})

test('uses revision and connector id as stable fallbacks for incomplete job presentation', () => {
  const entries = customConnectorEntries(
    [],
    [
      job('first', { title: ' ', summary: ' ', updatedAt: 'invalid', revision: 1 }),
      job('second', { title: undefined, summary: undefined, updatedAt: 'invalid', revision: 2 })
    ]
  )

  assert.deepEqual(
    entries.map((entry) => [entry.name, entry.subtitle]),
    [
      ['second', 'second'],
      ['first', 'first']
    ]
  )
  assert.deepEqual(mergeCustomConnectorJobs([], [job('ignored', { kind: undefined })]), [])
})
