import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ConnectorSetupTracker } from '../src/main/agent/mcp/connector-setup'
import { createLocalConnectorJobs } from '../src/main/agent/mcp/local-connector-jobs'
import type { LocalMcpConnectorRequest } from '../src/shared/mcpConnectorCatalog'

type Deferred<T> = {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: Error): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function fixture(): {
  root: string
  agentDir: string
  request: LocalMcpConnectorRequest
  cleanup(): void
} {
  const root = mkdtempSync(join(tmpdir(), 'phi-local-connector-job-'))
  const agentDir = join(root, 'agent')
  const command = join(root, 'server')
  mkdirSync(agentDir)
  writeFileSync(command, '#!/bin/sh\nexit 0\n')
  chmodSync(command, 0o700)
  return {
    root,
    agentDir,
    request: {
      name: 'mail',
      runtime: { kind: 'host' },
      command,
      args: ['--stdio'],
      env: { API_LABEL: 'super-secret-value' }
    },
    cleanup: () => rmSync(root, { recursive: true, force: true })
  }
}

async function waitForTerminal(
  tracker: ConnectorSetupTracker,
  name: string
): Promise<NonNullable<ReturnType<ConnectorSetupTracker['get']>>> {
  const deadline = Date.now() + 3_000
  while (true) {
    const snapshot = tracker.get(name)
    if (snapshot && ['ready', 'failed'].includes(snapshot.phase)) return snapshot
    assert.ok(Date.now() < deadline, `job ${name} did not finish`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function waitForTerminalAfterRevision(
  tracker: ConnectorSetupTracker,
  name: string,
  revision: number
): Promise<NonNullable<ReturnType<ConnectorSetupTracker['get']>>> {
  const deadline = Date.now() + 3_000
  while (true) {
    const snapshot = tracker.get(name)
    if (snapshot && snapshot.revision > revision && ['ready', 'failed'].includes(snapshot.phase)) {
      return snapshot
    }
    assert.ok(Date.now() < deadline, `job ${name} did not finish after revision ${revision}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('local connector start returns immediately and only writes after a successful probe', async () => {
  const f = fixture()
  try {
    const pending = deferred<string[]>()
    const applied: string[] = []
    const events: unknown[] = []
    const tracker = new ConnectorSetupTracker(() => {})
    const jobs = createLocalConnectorJobs({
      tracker,
      agentDir: f.agentDir,
      runtimeRoot: join(f.root, 'runtime'),
      probe: (request) => {
        assert.equal(request.captureStderr, true)
        return pending.promise
      },
      cancelProbe: () => undefined,
      applyEnabled: async (name) => applied.push(name),
      now: () => '2026-10-11T08:00:00.000Z',
      requestKey: () => 'request-1',
      onEvent: (event, metadata) => events.push({ event, metadata })
    })

    assert.deepEqual(jobs.startLocalConnectorAdd(f.request), { started: true, name: 'mail' })
    assert.equal(tracker.get('mail')?.phase, 'starting')
    assert.equal(existsSync(join(f.agentDir, 'mcp.json')), false)
    assert.deepEqual(
      jobs.listLocalConnectorJobs().map(({ id }) => id),
      ['mail']
    )

    pending.resolve(['send_mail', 'list_mail'])
    const completed = await waitForTerminal(tracker, 'mail')
    assert.equal(completed.phase, 'ready')
    assert.equal(completed.detail, undefined)
    assert.deepEqual(completed.toolNames, ['send_mail', 'list_mail'])
    assert.deepEqual(applied, ['mail'])
    assert.deepEqual(events, [
      { event: 'started', metadata: { name: 'mail', runtimeKind: 'host' } },
      { event: 'succeeded', metadata: { name: 'mail', runtimeKind: 'host' } }
    ])
    assert.doesNotMatch(JSON.stringify(events), /super-secret-value|--stdio/)
    const config = JSON.parse(readFileSync(join(f.agentDir, 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, { enabled?: boolean }>
    }
    assert.equal(config.mcpServers.mail?.enabled, true)
  } finally {
    f.cleanup()
  }
})

test('local connector validation and runtime errors throw synchronously before a job exists', () => {
  const f = fixture()
  try {
    const tracker = new ConnectorSetupTracker(() => {})
    const jobs = createLocalConnectorJobs({
      tracker,
      agentDir: f.agentDir,
      runtimeRoot: join(f.root, 'runtime'),
      probe: async () => [],
      cancelProbe: () => undefined,
      applyEnabled: () => undefined,
      resolveBunExecutable: () => {
        throw new Error('missing')
      }
    })
    assert.throws(
      () => jobs.startLocalConnectorAdd({ ...f.request, name: 'BAD NAME' }),
      /名称|name/i
    )
    assert.throws(
      () =>
        jobs.startLocalConnectorAdd({
          ...f.request,
          name: 'bun-mail',
          runtime: { kind: 'bun' },
          command: 'x'
        }),
      /Bundled Bun was not found/
    )
    assert.deepEqual(jobs.listLocalConnectorJobs(), [])
  } finally {
    f.cleanup()
  }
})

test('probe failure and cancellation end failed without writing configuration', async () => {
  for (const mode of ['failure', 'cancel'] as const) {
    const f = fixture()
    try {
      const pending = deferred<string[]>()
      const probeEntered = deferred<void>()
      const cancelled: string[] = []
      const tracker = new ConnectorSetupTracker(() => {})
      const jobs = createLocalConnectorJobs({
        tracker,
        agentDir: f.agentDir,
        runtimeRoot: join(f.root, 'runtime'),
        probe: () => {
          probeEntered.resolve()
          return pending.promise
        },
        cancelProbe: (requestKey) => {
          cancelled.push(requestKey)
          pending.reject(new Error('worker aborted'))
        },
        applyEnabled: () => undefined,
        requestKey: () => `request-${mode}`
      })
      jobs.startLocalConnectorAdd(f.request)
      await probeEntered.promise
      if (mode === 'failure') pending.reject(new Error('fixture probe failed'))
      else await jobs.cancelLocalConnectorAdd('mail')

      const failed = await waitForTerminal(tracker, 'mail')
      assert.equal(failed.phase, 'failed')
      assert.equal(failed.failedPhase, 'starting')
      assert.equal(failed.error, mode === 'failure' ? 'fixture probe failed' : 'Cancelled')
      assert.equal(failed.detail, undefined)
      assert.equal(failed.failureKind, mode === 'failure' ? 'generic' : undefined)
      assert.equal(failed.failureReason, undefined)
      assert.deepEqual(cancelled, mode === 'cancel' ? ['request-cancel'] : [])
      assert.equal(existsSync(join(f.agentDir, 'mcp.json')), false)
    } finally {
      f.cleanup()
    }
  }
})

test('pre-handshake probe failure stores stderr detail and adds the initialization hint', async () => {
  const f = fixture()
  try {
    const tracker = new ConnectorSetupTracker(() => {})
    const jobs = createLocalConnectorJobs({
      tracker,
      agentDir: f.agentDir,
      runtimeRoot: join(f.root, 'runtime'),
      probe: async () => {
        throw Object.assign(new Error('MCP subprocess closed stdout before responding'), {
          detail: 'Config not found, run init first'
        })
      },
      cancelProbe: () => undefined,
      applyEnabled: () => undefined
    })
    const request = {
      ...f.request,
      hint: {
        readmeUrl: 'https://github.com/xieningqing/qq-email-mcp/blob/abc/README.md',
        setupCommands: ['npx -y qq-email-mcp init']
      }
    }
    jobs.startLocalConnectorAdd(request)

    const failed = await waitForTerminal(tracker, 'mail')
    assert.equal(failed.phase, 'failed')
    assert.equal(failed.detail, 'Config not found, run init first')
    assert.equal(
      failed.error,
      'MCP subprocess closed stdout before responding\nThe service exited before responding. See details for process output. If initialization is required (such as running init), complete it in the terminal first.'
    )
    assert.equal(failed.failureKind, 'needs-setup')
    assert.equal(failed.failureReason, 'Config not found, run init first')
    assert.deepEqual(failed.setupHint, {
      readmeUrl: request.hint.readmeUrl,
      commands: request.hint.setupCommands
    })

    jobs.retryLocalConnectorAdd('mail')
    const retried = await waitForTerminalAfterRevision(tracker, 'mail', failed.revision)
    assert.equal(retried.failureKind, 'needs-setup')
    assert.deepEqual(retried.setupHint, failed.setupHint)
    assert.equal(existsSync(join(f.agentDir, 'mcp.json')), false)
  } finally {
    f.cleanup()
  }
})

test('non-handshake probe failure stores detail without changing the error message', async () => {
  const f = fixture()
  try {
    const tracker = new ConnectorSetupTracker(() => {})
    const jobs = createLocalConnectorJobs({
      tracker,
      agentDir: f.agentDir,
      runtimeRoot: join(f.root, 'runtime'),
      probe: async () => {
        throw Object.assign(new Error('fixture tool-list failure'), { detail: 'server output' })
      },
      cancelProbe: () => undefined,
      applyEnabled: () => undefined
    })
    jobs.startLocalConnectorAdd(f.request)

    const failed = await waitForTerminal(tracker, 'mail')
    assert.equal(failed.error, 'fixture tool-list failure')
    assert.equal(failed.detail, 'server output')
    assert.equal(failed.failureKind, 'generic')
    assert.equal(failed.failureReason, undefined)
  } finally {
    f.cleanup()
  }
})

test('active names are reserved and a failed in-memory request can be retried', async () => {
  const f = fixture()
  try {
    const first = deferred<string[]>()
    let attempts = 0
    const tracker = new ConnectorSetupTracker(() => {})
    const jobs = createLocalConnectorJobs({
      tracker,
      agentDir: f.agentDir,
      runtimeRoot: join(f.root, 'runtime'),
      probe: () => {
        attempts += 1
        return attempts === 1 ? first.promise : Promise.resolve(['retried'])
      },
      cancelProbe: () => undefined,
      applyEnabled: () => undefined
    })
    jobs.startLocalConnectorAdd(f.request)
    assert.throws(() => jobs.startLocalConnectorAdd(f.request), /in progress/)
    first.reject(new Error('first failure'))
    await waitForTerminal(tracker, 'mail')
    assert.deepEqual(jobs.retryLocalConnectorAdd('mail'), { started: true, name: 'mail' })
    assert.equal((await waitForTerminal(tracker, 'mail')).phase, 'ready')

    const afterRestart = createLocalConnectorJobs({
      tracker,
      agentDir: f.agentDir,
      runtimeRoot: join(f.root, 'runtime'),
      probe: async () => [],
      cancelProbe: () => undefined,
      applyEnabled: () => undefined
    })
    assert.throws(() => afterRestart.retryLocalConnectorAdd('missing'), /Cannot retry/)
  } finally {
    f.cleanup()
  }
})

test('collision is checked again immediately before the successful write', async () => {
  const f = fixture()
  try {
    const pending = deferred<string[]>()
    const tracker = new ConnectorSetupTracker(() => {})
    const jobs = createLocalConnectorJobs({
      tracker,
      agentDir: f.agentDir,
      runtimeRoot: join(f.root, 'runtime'),
      probe: () => pending.promise,
      cancelProbe: () => undefined,
      applyEnabled: () => undefined
    })
    jobs.startLocalConnectorAdd(f.request)
    writeFileSync(
      join(f.agentDir, 'mcp.json'),
      JSON.stringify({ mcpServers: { mail: { url: 'https://external.example/mcp' } } })
    )
    pending.resolve(['tool'])
    const failed = await waitForTerminal(tracker, 'mail')
    assert.equal(failed.phase, 'failed')
    assert.match(failed.error ?? '', /MCP configuration mail already exists/)
    assert.match(readFileSync(join(f.agentDir, 'mcp.json'), 'utf8'), /external\.example/)
  } finally {
    f.cleanup()
  }
})

test('persisted local job presentation contains no environment values', async () => {
  const f = fixture()
  try {
    const statePath = join(f.root, 'connector-setup.json')
    const tracker = new ConnectorSetupTracker(() => {}, undefined, { path: statePath })
    const jobs = createLocalConnectorJobs({
      tracker,
      agentDir: f.agentDir,
      runtimeRoot: join(f.root, 'runtime'),
      probe: async () => ['tool'],
      cancelProbe: () => undefined,
      applyEnabled: () => undefined,
      now: () => '2026-10-11T08:00:00.000Z'
    })
    jobs.startLocalConnectorAdd(f.request)
    const ready = await waitForTerminal(tracker, 'mail')
    assert.equal(ready.kind, 'local-stdio')
    assert.equal(ready.title, 'mail')
    assert.equal(ready.startedAt, '2026-10-11T08:00:00.000Z')
    assert.match(ready.summary ?? '', /server --stdio/)
    assert.match(ready.summary ?? '', /API_LABEL/)
    assert.doesNotMatch(ready.summary ?? '', /super-secret-value/)
    assert.doesNotMatch(readFileSync(statePath, 'utf8'), /super-secret-value/)
  } finally {
    f.cleanup()
  }
})

test('persisted setup guidance contains validated hints but never environment values', async () => {
  const f = fixture()
  try {
    const statePath = join(f.root, 'connector-setup.json')
    const tracker = new ConnectorSetupTracker(() => {}, undefined, { path: statePath })
    const jobs = createLocalConnectorJobs({
      tracker,
      agentDir: f.agentDir,
      runtimeRoot: join(f.root, 'runtime'),
      probe: async () => {
        throw Object.assign(new Error('MCP subprocess closed stdout before responding'), {
          detail: 'Configuration file not found: /tmp/mail.toml'
        })
      },
      cancelProbe: () => undefined,
      applyEnabled: () => undefined
    })
    jobs.startLocalConnectorAdd({
      ...f.request,
      hint: {
        readmeUrl: 'https://github.com/example/mail/blob/main/README.md',
        setupCommands: ['mail-server init']
      }
    })
    await waitForTerminal(tracker, 'mail')

    const persisted = readFileSync(statePath, 'utf8')
    assert.match(persisted, /"failureKind":"needs-setup"/)
    assert.match(persisted, /"commands":\["mail-server init"\]/)
    assert.doesNotMatch(persisted, /super-secret-value/)
  } finally {
    f.cleanup()
  }
})
