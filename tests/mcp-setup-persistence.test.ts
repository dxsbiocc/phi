import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ConnectorSetupTracker } from '../src/main/agent/mcp/connector-setup'

function fixture(run: (path: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'phi-setup-persist-'))
  return run(join(root, 'setup.json')).finally(() => rmSync(root, { recursive: true, force: true }))
}

test('setup state restores operation identity and validated phase without persisting tool schemas', async () => {
  await fixture(async (path) => {
    const tracker = new ConnectorSetupTracker(() => {}, undefined, { path })
    await tracker.run('biomcp', (report) => {
      report('starting')
      report('ready', { toolNames: ['private_schema_name'] })
    })
    const before = tracker.get('biomcp')!
    assert.match(before.operationId!, /^[0-9a-f-]{36}$/)
    const restored = new ConnectorSetupTracker(() => {}, undefined, { path }).get('biomcp')!
    assert.equal(restored.phase, 'ready')
    assert.equal(restored.operationId, before.operationId)
    assert.equal(restored.revision, before.revision)
    assert.equal(restored.toolNames, undefined)
    assert.doesNotMatch(readFileSync(path, 'utf8'), /private_schema_name/)
    assert.equal(statSync(path).mode & 0o777, 0o600)
  })
})

test('an interrupted install restores as failed and permits a fresh explicit retry', async () => {
  await fixture(async (path) => {
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        records: [
          {
            id: 'biomcp',
            phase: 'installing',
            revision: 2,
            updatedAt: '2026-10-09T00:00:00Z',
            operationId: '11111111-1111-4111-8111-111111111111'
          }
        ]
      })
    )
    const tracker = new ConnectorSetupTracker(() => {}, undefined, { path })
    const failed = tracker.get('biomcp')!
    assert.equal(failed.phase, 'failed')
    assert.equal(failed.failedPhase, 'installing')
    assert.match(failed.error!, /中断/)
    assert.equal(failed.revision, 3)
    await tracker.run('biomcp', (report) => report('starting'))
    const ready = tracker.get('biomcp')!
    assert.equal(ready.phase, 'ready')
    assert.ok(ready.revision > failed.revision)
    assert.notEqual(ready.operationId, failed.operationId)
  })
})

test('corrupt or oversized lifecycle files are quarantined without entering the active state', async () => {
  await fixture(async (path) => {
    writeFileSync(path, '{malformed')
    assert.equal(new ConnectorSetupTracker(() => {}, undefined, { path }).get('biomcp'), undefined)
    writeFileSync(path, Buffer.alloc(2 * 1024 * 1024 + 1))
    assert.equal(new ConnectorSetupTracker(() => {}, undefined, { path }).get('biomcp'), undefined)
    assert.equal(
      readdirSync(join(path, '..')).filter((name) => name.includes('.corrupt-')).length,
      2
    )
  })
})

test('removal persists a newer cleared terminal record across restart', async () => {
  await fixture(async (path) => {
    const tracker = new ConnectorSetupTracker(() => {}, undefined, { path })
    await tracker.run('biomcp', (report) => report('ready', { toolNames: ['tool'] }))
    await tracker.run('biomcp', () => undefined, 'removed')
    const restored = new ConnectorSetupTracker(() => {}, undefined, { path }).get('biomcp')!
    assert.equal(restored.phase, 'removed')
    assert.equal(restored.toolNames, undefined)
  })
})
