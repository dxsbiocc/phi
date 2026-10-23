import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createHash } from 'node:crypto'
import {
  buildRuntimeRecoverySummary,
  readRuntimeRecoverySummarySeed
} from '../src/main/agent/session/recovery-summary'
import {
  registerRuntimeSessionOrigin,
  resolveRuntimeSessionOrigin
} from '../src/main/agent/session/runtime-origin-store'
import type {
  PhiSessionManifest,
  StoredSessionEvent
} from '../src/main/agent/session/session-store'
import type { RemoteOmpScope } from '../src/main/agent/session/runtime-reference'
import {
  parseRuntimeReference,
  remoteOmpDurableSessionKey
} from '../src/main/agent/session/runtime-reference'
import {
  readColdChildRuns,
  recordChildRunRecovery,
  type ChildRunRecoverySnapshot
} from '../src/main/agent/session/child-run-recovery'
import {
  describeRemoteRecoveryFailure,
  RemoteRecoveryError
} from '../src/main/agent/engine/rpc/session-recovery'
import { RemoteSessionStorageError } from '../src/main/agent/engine/rpc/session-storage/types'
import { SessionVerificationError } from '../src/main/agent/engine/phi-extension/lib/rpc-session-verification-protocol'
import { CodedError } from '../src/shared/errorCodes'
import { runtimeRecoveryMessage } from '../src/main/agent/session/runtime-recovery-ipc'

const scope: RemoteOmpScope = {
  projectId: 'project',
  hostProfileId: 'host',
  bindingHash: 'a'.repeat(64),
  projectRoot: '/server/project',
  runtimeRoot: '/server/runtime'
}
function manifest(): PhiSessionManifest {
  return {
    schemaVersion: 1,
    sessionId: 'phi',
    kind: 'project',
    projectId: 'project',
    projectLocation: {
      kind: 'ssh',
      hostProfileId: 'host',
      remoteRoot: '/server/project',
      canonicalRoot: '/server/project'
    },
    cwd: '/desktop/anchor',
    cwdRealPath: '/desktop/anchor',
    permissionMode: 'ask',
    status: 'idle',
    unreadKind: null,
    messageCount: 0,
    createdAt: '2026-10-15T00:00:00.000Z',
    updatedAt: '2026-10-15T00:00:00.000Z',
    lastActivityAt: '2026-10-15T00:00:00.000Z'
  }
}
function event(type: string, content: unknown, index: number): StoredSessionEvent {
  return {
    type,
    content,
    eventId: 'event-' + index,
    sessionId: 'phi',
    createdAt: '2026-10-15T00:00:00.000Z'
  }
}

test('D5 derives only bounded local conversation excerpts with deterministic provenance', () => {
  const events = [
    event('user_message', 'goal', 1),
    event('tool_call_finished', 'PRIVATE_TOOL', 2),
    {
      ...event('assistant_message_finalized', 'answer', 3),
      outputPath: '/server/journal',
      details: { apiKey: 'PRIVATE_KEY' }
    }
  ]
  const result = buildRuntimeRecoverySummary({
    sourceSessionId: 'phi',
    projectId: 'project',
    events
  })
  assert.match(result.content, /goal/)
  assert.match(result.content, /answer/)
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TOOL|PRIVATE_KEY|\/server\/journal/)
  assert.equal(result.provenance.throughEventId, 'event-3')
  assert.equal(result.provenance.eventCount, 3)
  assert.deepEqual(
    result,
    buildRuntimeRecoverySummary({ sourceSessionId: 'phi', projectId: 'project', events })
  )
  assert.notEqual(
    result.provenance.sha256,
    buildRuntimeRecoverySummary({
      sourceSessionId: 'phi',
      projectId: 'project',
      events: [...events, event('run_interrupted', '', 4)]
    }).provenance.sha256
  )
  const large = buildRuntimeRecoverySummary({
    sourceSessionId: 'phi',
    projectId: 'project',
    events: Array.from({ length: 1000 }, (_, i) => event('user_message', '中文'.repeat(10000), i))
  })
  assert.ok(Buffer.byteLength(large.content) <= 16 * 1024)
  assert.match(large.content, /摘录/)
  assert.throws(
    () =>
      buildRuntimeRecoverySummary({
        sourceSessionId: 'phi',
        projectId: 'project',
        events: [
          event('user_message', 'peer', 1),
          { ...event('user_message', 'wrong', 2), sessionId: 'peer' }
        ]
      }),
    /身份/
  )
})

test('D5 seed retains an accepted snapshot after source deletion and rejects corrupt/peer/duplicate seeds', () => {
  const summary = buildRuntimeRecoverySummary({
    sourceSessionId: 'phi',
    projectId: 'project',
    events: [event('user_message', 'preserved context', 1)]
  })
  const seed = {
    ...event('runtime_recovery_summary', summary.content, 2),
    sessionId: 'new-phi',
    provenance: summary.provenance,
    contentSha256: createHash('sha256').update(summary.content).digest('hex')
  }
  const input = { sessionId: 'new-phi', projectId: 'project', events: [seed] }
  assert.deepEqual(readRuntimeRecoverySummarySeed(input), summary)
  assert.equal(readRuntimeRecoverySummarySeed({ ...input, events: [] }), undefined)
  for (const changed of [
    { ...seed, content: 'corrupt' },
    { ...seed, sessionId: 'peer' },
    { ...seed, secret: 'private' },
    { ...seed, provenance: { ...summary.provenance, projectId: 'peer' } },
    { ...seed, provenance: { ...summary.provenance, sourceSessionId: 'new-phi' } }
  ])
    assert.throws(() => readRuntimeRecoverySummarySeed({ ...input, events: [changed] }), /摘要/)
  assert.throws(
    () =>
      readRuntimeRecoverySummarySeed({
        ...input,
        events: [seed, { ...seed, eventId: 'duplicate' }]
      }),
    /不唯一/
  )
})

test('cold origin resolves only after current Phi/project/host binding revalidation', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'phi-origin-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const input = {
    runtimeSessionId: 'old-runtime',
    phiSessionId: 'phi',
    projectId: 'project',
    cwd: '/desktop/anchor',
    remoteScope: scope,
    configuredRuntimeRoot: null
  }
  registerRuntimeSessionOrigin(input, dir)
  const current = manifest()
  let currentScope: RemoteOmpScope | undefined = scope
  const options = {
    readManifest: () => current,
    resolveRemoteScope: () => currentScope,
    resolveConfiguredRuntimeRoot: () => null
  }
  assert.deepEqual(resolveRuntimeSessionOrigin('old-runtime', options, dir), {
    phiSessionId: 'phi',
    cwd: '/desktop/anchor'
  })
  assert.equal(
    resolveRuntimeSessionOrigin(
      'old-runtime',
      { ...options, resolveConfiguredRuntimeRoot: () => '/changed/runtime' },
      dir
    ),
    undefined
  )
  assert.equal(
    resolveRuntimeSessionOrigin(
      'old-runtime',
      { ...options, resolveConfiguredRuntimeRoot: undefined },
      dir
    ),
    undefined
  )
  currentScope = { ...scope, bindingHash: 'b'.repeat(64) }
  assert.equal(resolveRuntimeSessionOrigin('old-runtime', options, dir), undefined)
  currentScope = scope
  current.projectId = 'peer'
  assert.equal(resolveRuntimeSessionOrigin('old-runtime', options, dir), undefined)
  current.projectId = 'project'
  current.cwd = '/different/anchor'
  assert.equal(resolveRuntimeSessionOrigin('old-runtime', options, dir), undefined)
  assert.equal(resolveRuntimeSessionOrigin('unknown', options, dir), undefined)
  assert.throws(
    () => registerRuntimeSessionOrigin({ ...input, phiSessionId: 'peer' }, dir),
    /origin/
  )
})

test('origin disk corruption and symlink cannot redirect recovery or change a victim', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'phi-origin-disk-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = registerRuntimeSessionOrigin(
    {
      runtimeSessionId: 'runtime',
      phiSessionId: 'phi',
      projectId: 'project',
      cwd: '/desktop/anchor',
      remoteScope: scope,
      configuredRuntimeRoot: null
    },
    dir
  )
  const options = {
    readManifest: () => manifest(),
    resolveRemoteScope: () => scope,
    resolveConfiguredRuntimeRoot: () => null
  }
  writeFileSync(path, JSON.stringify({ apiKey: 'private', phiSessionId: 'peer' }))
  assert.equal(resolveRuntimeSessionOrigin('runtime', options, dir), undefined)
  rmSync(path)
  const victim = join(dir, 'victim')
  writeFileSync(victim, 'preserve')
  symlinkSync(victim, path)
  assert.equal(resolveRuntimeSessionOrigin('runtime', options, dir), undefined)
  assert.throws(() =>
    registerRuntimeSessionOrigin(
      {
        runtimeSessionId: 'runtime',
        phiSessionId: 'phi',
        projectId: 'project',
        cwd: '/desktop/anchor',
        remoteScope: scope,
        configuredRuntimeRoot: null
      },
      dir
    )
  )
  assert.equal(readFileSync(victim, 'utf8'), 'preserve')
})

test('private recovery reader rejects a FIFO without blocking the main process', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'phi-recovery-fifo-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const fifo = join(dir, 'fifo')
  execFileSync('mkfifo', [fifo])
  const module = new URL('../src/main/agent/session/private-recovery-file.ts', import.meta.url).href
  const loader = fileURLToPath(new URL('../scripts/test-loader.mjs', import.meta.url))
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      loader,
      '--input-type=module',
      '-e',
      `import { readRecoveryFile } from ${JSON.stringify(module)}; try { readRecoveryFile(process.argv[1]); process.exitCode = 1 } catch { process.stdout.write('rejected-nonregular') }`,
      fifo
    ],
    { encoding: 'utf8', timeout: 600 }
  )
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  assert.equal(result.stdout, 'rejected-nonregular')
})

test('ordinary origin normalizes absent project and rejects a later remote conversion', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'phi-origin-ordinary-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  registerRuntimeSessionOrigin(
    { runtimeSessionId: 'local', phiSessionId: 'phi', projectId: null, cwd: '/desktop/anchor' },
    dir
  )
  const current = {
    ...manifest(),
    kind: 'ordinary',
    projectId: undefined,
    projectLocation: undefined
  } as unknown as PhiSessionManifest
  const options = { readManifest: () => current, resolveRemoteScope: () => undefined }
  assert.deepEqual(resolveRuntimeSessionOrigin('local', options, dir), {
    phiSessionId: 'phi',
    cwd: '/desktop/anchor'
  })
  current.projectLocation = manifest().projectLocation
  assert.equal(resolveRuntimeSessionOrigin('local', options, dir), undefined)
})

const reference = parseRuntimeReference(
  {
    ...scope,
    kind: 'remote-omp',
    version: 1,
    durableSessionKey: remoteOmpDurableSessionKey(scope, 'phi'),
    ompSessionId: 'root-omp',
    journalBasename: 'root.jsonl',
    ompVersion: '18.10.3'
  },
  'phi'
)
function child(id = 'child'): ChildRunRecoverySnapshot {
  return {
    id,
    phiSessionId: 'phi',
    projectId: 'project',
    generation: 1,
    parentRunId: 'parent',
    parentToolCallId: 'tool-call',
    nativeId: 'native',
    childSessionFile: `${scope.runtimeRoot}/omp-sessions/${reference.durableSessionKey}/journals/root/child.jsonl`,
    agent: 'expert',
    background: true,
    status: 'running',
    verified: true,
    startedAt: Date.parse('2026-10-15T00:00:00.000Z')
  }
}

test('child cold metadata marks unknown live work interrupted without reading or controlling its server journal', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'phi-child-cold-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  let guards = 0
  recordChildRunRecovery(
    { reference, snapshot: child() },
    {
      assertCurrent: () => {
        guards++
      }
    },
    dir
  )
  assert.equal(guards, 2)
  let [cold] = readColdChildRuns({ phiSessionId: 'phi', reference }, dir)
  assert.equal(cold.status, 'interrupted')
  assert.equal(cold.canControl, false)
  assert.equal(cold.historyAvailable, false)
  recordChildRunRecovery(
    {
      reference,
      snapshot: {
        ...child(),
        status: 'completed',
        completedAt: Date.parse('2026-10-15T00:00:01.000Z')
      }
    },
    {},
    dir
  )
  recordChildRunRecovery({ reference, snapshot: child() }, {}, dir)
  ;[cold] = readColdChildRuns({ phiSessionId: 'phi', reference }, dir)
  assert.equal(
    cold.status,
    'completed',
    'observed terminal cannot be downgraded by a stale running event'
  )
  const rebound = { ...scope, bindingHash: 'b'.repeat(64) }
  assert.throws(
    () =>
      readColdChildRuns(
        {
          phiSessionId: 'phi',
          reference: {
            ...reference,
            ...rebound,
            durableSessionKey: remoteOmpDurableSessionKey(rebound, 'phi')
          }
        },
        dir
      ),
    /binding/
  )
  assert.throws(
    () =>
      recordChildRunRecovery(
        { reference, snapshot: { ...child(), childSessionFile: '/desktop/secret.jsonl' } },
        {},
        dir
      ),
    /outside/
  )
  assert.throws(
    () =>
      recordChildRunRecovery({ reference, snapshot: { ...child(), projectId: 'peer' } }, {}, dir),
    /snapshot/
  )
  assert.throws(
    () =>
      recordChildRunRecovery(
        { reference, snapshot: child('cancelled') },
        {
          assertCurrent: () => {
            throw new Error('retired')
          }
        },
        dir
      ),
    /retired/
  )
  assert.equal(readColdChildRuns({ phiSessionId: 'phi', reference }, dir).length, 1)
  recordChildRunRecovery(
    {
      reference,
      snapshot: {
        ...child('opaque'),
        parentToolCallId: 'call:item|cursor',
        nativeId: 'agent:child.1'
      }
    },
    {},
    dir
  )
  assert.equal(readColdChildRuns({ phiSessionId: 'phi', reference }, dir).length, 2)
})

test('recovery user diagnostics distinguish exact missing/corrupt/model/asset failures without raw errors', () => {
  const cases = [
    [
      new RemoteRecoveryError('MODEL_UNAVAILABLE', 'private-provider-credential'),
      'model-unavailable'
    ],
    [new RemoteSessionStorageError('FILE_MISSING', 'private-server-path'), 'journal-missing'],
    [new RemoteSessionStorageError('FILE_INVALID', 'private-server-content'), 'journal-invalid'],
    [new SessionVerificationError('ASSET_MISSING'), 'asset-missing'],
    [new RemoteRecoveryError('IDENTITY_MISMATCH', 'private-host'), 'binding-changed'],
    [new CodedError('DOMAIN_CONFLICT', 'private-lock-owner'), 'run-held'],
    [Object.assign(new Error('private-authentication'), { code: 'FILE_MISSING' }), 'disconnected']
  ] as const
  for (const [error, issue] of cases) {
    const result = describeRemoteRecoveryFailure(error)
    assert.equal(result.issue, issue)
    assert.doesNotMatch(JSON.stringify(result), /private-/)
  }
  assert.match(runtimeRecoveryMessage('run-held'), /另一个进程占用/)
})

test('fresh Node process restores only persisted provenance and interrupted child metadata', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'phi-recovery-cold-process-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  registerRuntimeSessionOrigin(
    {
      runtimeSessionId: 'old-runtime',
      phiSessionId: 'phi',
      projectId: 'project',
      cwd: '/desktop/anchor',
      remoteScope: scope,
      configuredRuntimeRoot: null
    },
    dir
  )
  recordChildRunRecovery({ reference, snapshot: child() }, {}, dir)
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ ...manifest(), runtimeRef: reference })
  )
  const oracle = fileURLToPath(new URL('./helpers/runtimeRecoveryColdOracle.ts', import.meta.url))
  const loader = fileURLToPath(new URL('../scripts/test-loader.mjs', import.meta.url))
  const result = spawnSync(process.execPath, ['--import', loader, oracle, dir], {
    encoding: 'utf8',
    timeout: 5000
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), {
    origin: { phiSessionId: 'phi', cwd: '/desktop/anchor' },
    children: [{ id: 'child', status: 'interrupted', canControl: false, historyAvailable: false }]
  })
})
