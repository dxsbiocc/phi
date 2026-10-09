import assert from 'node:assert/strict'
import test from 'node:test'

import { ConnectorSetupTracker } from '../src/main/agent/mcp/connector-setup'
import type { McpConnectorSetupProgress } from '../src/shared/mcpConnectorCatalog'

test('setup publishes real stages in order and retains a ready snapshot for reopened dialogs', async () => {
  const events: McpConnectorSetupProgress[] = []
  let tick = 0
  const tracker = new ConnectorSetupTracker(
    (event) => events.push(event),
    () => `time-${++tick}`
  )
  assert.equal(tracker.get('local'), undefined)
  const tools = ['search', 'fetch']
  assert.equal(
    await tracker.run('local', async (report) => {
      report('downloading')
      report('installing')
      report('environment')
      report('starting')
      report('ready', { toolNames: tools })
      return 'installed-result'
    }),
    'installed-result'
  )
  assert.deepEqual(
    events.map(({ phase }) => phase),
    ['downloading', 'installing', 'environment', 'starting', 'ready']
  )
  assert.deepEqual(
    events.map(({ revision }) => revision),
    [1, 2, 3, 4, 5]
  )
  assert.deepEqual(
    events.map(({ updatedAt }) => updatedAt),
    ['time-1', 'time-2', 'time-3', 'time-4', 'time-5']
  )
  assert.deepEqual(tracker.get('local'), {
    id: 'local',
    phase: 'ready',
    revision: 5,
    updatedAt: 'time-5',
    toolNames: tools
  })
  tools.push('caller-mutation')
  tracker.get('local')!.toolNames!.push('snapshot-mutation')
  events.at(-1)!.toolNames!.push('event-mutation')
  assert.deepEqual(tracker.get('local')?.toolNames, ['search', 'fetch'])
})

test('failure remembers the active stage, rethrows, and permits a clean retry with newer revisions', async () => {
  const events: McpConnectorSetupProgress[] = []
  const tracker = new ConnectorSetupTracker((event) => events.push(event))
  const failure = new Error('fixture startup failure')
  await assert.rejects(
    tracker.run('local', (report) => {
      report('environment')
      report('starting')
      throw failure
    }),
    (error: unknown) => error === failure
  )
  assert.deepEqual(
    events.map(({ phase }) => phase),
    ['environment', 'starting', 'failed']
  )
  assert.equal(tracker.get('local')?.failedPhase, 'starting')
  assert.equal(tracker.get('local')?.error, failure.message)
  await tracker.run('local', (report) => {
    report('starting')
    report('ready', { toolNames: ['healthy'] })
  })
  assert.deepEqual(
    events.map(({ revision }) => revision),
    [1, 2, 3, 4, 5]
  )
  assert.equal(tracker.get('local')?.phase, 'ready')
  assert.equal(tracker.get('local')?.error, undefined)
  assert.equal(tracker.get('local')?.failedPhase, undefined)
  assert.deepEqual(tracker.get('local')?.toolNames, ['healthy'])
})

test('same-id operations reject while active, other connectors remain independent, and stale reporters cannot replace terminal state', async () => {
  const events: McpConnectorSetupProgress[] = []
  const tracker = new ConnectorSetupTracker((event) => events.push(event))
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let retainedReport: Parameters<Parameters<ConnectorSetupTracker['run']>[1]>[0] | undefined
  const first = tracker.run('local', async (report) => {
    retainedReport = report
    report('starting')
    await pending
  })
  let duplicateRan = false
  await assert.rejects(
    tracker.run('local', () => {
      duplicateRan = true
    }),
    /进行中|already.*progress|busy/i
  )
  assert.equal(duplicateRan, false)
  let packageDeleted = false
  await assert.rejects(
    tracker.run(
      'local',
      () => {
        packageDeleted = true
      },
      'removed'
    ),
    /进行中|already.*progress|busy/i
  )
  assert.equal(packageDeleted, false)
  assert.equal(tracker.get('local')?.phase, 'starting')
  await tracker.run(
    'remote',
    (report) => {
      report('installing')
    },
    'installed'
  )
  assert.equal(tracker.get('remote')?.phase, 'installed')
  release()
  await first
  const revision = tracker.get('local')?.revision
  retainedReport?.('environment')
  assert.equal(tracker.get('local')?.phase, 'ready')
  assert.equal(tracker.get('local')?.revision, revision)
  await tracker.run('local', (report) => {
    report('starting')
    retainedReport?.('environment')
    assert.equal(tracker.get('local')?.phase, 'starting')
  })
  assert.equal(tracker.get('local')?.phase, 'ready')
})

test('HTTP installation finishes as installed and observer failure cannot break operation or retry', async () => {
  const tracker = new ConnectorSetupTracker(() => {
    throw new Error('window is closed')
  })
  assert.equal(
    await tracker.run(
      'remote',
      (report) => {
        report('installing')
        return 7
      },
      'installed'
    ),
    7
  )
  assert.equal(tracker.get('remote')?.phase, 'installed')
  await assert.rejects(
    tracker.run('remote', () => {
      throw 'fixture failure'
    }),
    /fixture failure/
  )
  assert.equal(tracker.get('remote')?.phase, 'failed')
  assert.equal(tracker.get('remote')?.failedPhase, undefined)
  await tracker.run(
    'remote',
    (report) => {
      report('installing')
    },
    'installed'
  )
  assert.equal(tracker.get('remote')?.error, undefined)
})

for (const priorPhase of ['ready', 'failed'] as const) {
  test(`removal replaces ${priorPhase} state with a newer snapshot and clears validation data`, async () => {
    const events: McpConnectorSetupProgress[] = []
    const tracker = new ConnectorSetupTracker((event) => events.push(event))
    await tracker.run('local', (report) => report('ready', { toolNames: ['search'] }))
    if (priorPhase === 'failed') {
      await assert.rejects(
        tracker.run('local', (report) => {
          report('starting')
          throw new Error('fixture discovery failure')
        }),
        /fixture discovery failure/
      )
    }
    const previous = tracker.get('local')!
    const result = { removed: 'local' }
    assert.equal(await tracker.run('local', () => result, 'removed'), result)
    const removed = tracker.get('local')!
    assert.equal(removed.phase, 'removed')
    assert.equal(removed.revision, previous.revision + 1)
    assert.equal(removed.toolNames, undefined)
    assert.equal(removed.error, undefined)
    assert.equal(removed.failedPhase, undefined)
    assert.deepEqual(events.at(-1), removed)
  })
}
