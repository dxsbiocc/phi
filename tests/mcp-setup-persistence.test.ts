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

test('local stdio setup metadata round-trips without persisting environment values', async () => {
  await fixture(async (path) => {
    const tracker = new ConnectorSetupTracker(() => {}, undefined, { path })
    await tracker.run('mail', (report) => {
      report('starting', {
        kind: 'local-stdio',
        title: 'mail',
        startedAt: '2026-10-11T08:00:00.000Z',
        summary: 'bun x --bun qq-email-mcp@0.1.1 · env: QQ_EMAIL_AUTH'
      })
      report('ready', { toolNames: ['send_mail'] })
    })

    const restored = new ConnectorSetupTracker(() => {}, undefined, { path }).get('mail')!
    assert.deepEqual(restored, {
      id: 'mail',
      phase: 'ready',
      revision: 2,
      updatedAt: restored.updatedAt,
      operationId: restored.operationId,
      kind: 'local-stdio',
      title: 'mail',
      startedAt: '2026-10-11T08:00:00.000Z',
      summary: 'bun x --bun qq-email-mcp@0.1.1 · env: QQ_EMAIL_AUTH'
    })
    assert.doesNotMatch(readFileSync(path, 'utf8'), /super-secret-value/)
  })
})

test('local stdio failure detail round-trips and is capped at 4096 characters', async () => {
  await fixture(async (path) => {
    const tracker = new ConnectorSetupTracker(() => {}, undefined, { path })
    const failure = Object.assign(new Error('fixture failed'), { detail: 'x'.repeat(5000) })
    await assert.rejects(
      tracker.run('mail', (report) => {
        report('starting', { kind: 'local-stdio', title: 'mail' })
        throw failure
      }),
      /fixture failed/
    )

    const current = tracker.get('mail')!
    assert.equal(current.detail?.length, 4096)
    assert.equal(current.detail, 'x'.repeat(4096))
    const restored = new ConnectorSetupTracker(() => {}, undefined, { path }).get('mail')!
    assert.equal(restored.detail, 'x'.repeat(4096))
    assert.match(readFileSync(path, 'utf8'), /"detail":"x+/)
  })
})

test('classified local failure guidance round-trips while old records remain valid', async () => {
  await fixture(async (path) => {
    const tracker = new ConnectorSetupTracker(() => {}, undefined, { path })
    await assert.rejects(
      tracker.run('mail', (report) => {
        report('starting', { kind: 'local-stdio', title: 'mail' })
        throw Object.assign(new Error('probe failed'), {
          detail: 'Configuration file not found: /tmp/mail.toml',
          failureKind: 'needs-setup',
          failureReason: 'Configuration file not found: /tmp/mail.toml',
          setupHint: {
            readmeUrl: 'https://github.com/example/mail/blob/main/README.md',
            commands: ['mail init']
          }
        })
      }),
      /probe failed/
    )

    const restored = new ConnectorSetupTracker(() => {}, undefined, { path }).get('mail')!
    assert.equal(restored.failureKind, 'needs-setup')
    assert.equal(restored.failureReason, 'Configuration file not found: /tmp/mail.toml')
    assert.deepEqual(restored.setupHint, {
      readmeUrl: 'https://github.com/example/mail/blob/main/README.md',
      commands: ['mail init']
    })

    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        records: [
          {
            id: 'old-mail',
            phase: 'failed',
            revision: 1,
            updatedAt: '2026-10-11T08:00:01.000Z',
            error: 'old failure'
          }
        ]
      })
    )
    const old = new ConnectorSetupTracker(() => {}, undefined, { path }).get('old-mail')!
    assert.equal(old.error, 'old failure')
    assert.equal(old.failureKind, undefined)
    assert.equal(old.setupHint, undefined)
  })
})

test('invalid persisted detail keeps the existing corrupt-file quarantine behavior', async () => {
  for (const detail of [7, 'x'.repeat(4097)]) {
    await fixture(async (path) => {
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          records: [
            {
              id: 'mail',
              phase: 'failed',
              revision: 1,
              updatedAt: '2026-10-11T08:00:01.000Z',
              error: 'fixture failed',
              detail
            }
          ]
        })
      )
      assert.equal(new ConnectorSetupTracker(() => {}, undefined, { path }).get('mail'), undefined)
      assert.equal(
        readdirSync(join(path, '..')).filter((name) => name.includes('.corrupt-')).length,
        1
      )
    })
  }
})

test('an interrupted local stdio job restores as failed with its presentation metadata', async () => {
  await fixture(async (path) => {
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        records: [
          {
            id: 'mail',
            phase: 'starting',
            revision: 1,
            updatedAt: '2026-10-11T08:00:01.000Z',
            kind: 'local-stdio',
            title: 'mail',
            startedAt: '2026-10-11T08:00:00.000Z',
            summary: 'bun x --bun qq-email-mcp@0.1.1',
            futurePresentationField: { ignored: true }
          }
        ]
      })
    )

    const restored = new ConnectorSetupTracker(() => {}, undefined, { path }).get('mail')!
    assert.equal(restored.phase, 'failed')
    assert.equal(restored.failedPhase, 'starting')
    assert.equal(restored.kind, 'local-stdio')
    assert.equal(restored.title, 'mail')
    assert.equal(restored.startedAt, '2026-10-11T08:00:00.000Z')
    assert.equal(restored.summary, 'bun x --bun qq-email-mcp@0.1.1')
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
