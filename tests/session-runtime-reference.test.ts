import assert from 'node:assert/strict'
import fs, {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test, { mock } from 'node:test'
import {
  assertRuntimeScope,
  parseRuntimeReference,
  remoteOmpDurableSessionKey,
  remoteOmpJournalPath,
  RuntimeReferenceError
} from '../src/main/agent/session/runtime-reference'
import {
  appendSessionEvent,
  beginRuntimeReferenceAdoption,
  createPhiSession,
  findPhiSessionById,
  listPhiSessions,
  readSessionEvents,
  updateSessionManifest
} from '../src/main/agent/session/session-store'
import {
  remoteReference,
  remoteReferenceScope,
  withRemoteReferenceSession
} from './helpers/sessionRuntimeReferenceFixture'
import {
  createSessionManager,
  deleteSession,
  phiOnlySessionPath,
  renameSession
} from '../src/main/agent/session/sessions'
import { exportPhiSession } from '../src/main/agent/session/session-export'

function fixture(run: (session: ReturnType<typeof createPhiSession>) => void): void {
  const previous = process.env.PI_CODING_AGENT_DIR
  const dir = mkdtempSync(join(tmpdir(), 'phi-runtime-reference-'))
  process.env.PI_CODING_AGENT_DIR = dir
  try {
    run(
      createPhiSession({
        kind: 'project',
        projectId: remoteReferenceScope.projectId,
        projectLocation: {
          kind: 'ssh',
          hostProfileId: remoteReferenceScope.hostProfileId,
          remoteRoot: remoteReferenceScope.projectRoot,
          canonicalRoot: remoteReferenceScope.projectRoot
        },
        cwd: '/desktop/anchor',
        cwdRealPath: '/desktop/anchor',
        title: 'Remote task',
        permissionMode: 'ask',
        model: { providerId: 'fixture', modelId: 'selected' }
      })
    )
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  }
}

function invalid(error: unknown): boolean {
  return error instanceof RuntimeReferenceError && error.code === 'INVALID_RUNTIME_REFERENCE'
}

test('remote locator key matches server derivation and is bound to the stable Phi ID', () => {
  const ref = remoteReference('phi-session-1')
  assert.equal(
    ref.durableSessionKey,
    'b809f994706ebc24c86d7e758d4e5a0fab816640523c38745c6715677454bbf1/phi-session-1'
  )
  const parsed = parseRuntimeReference(JSON.parse(JSON.stringify(ref)), 'phi-session-1')
  assert.deepEqual(parsed, ref)
  assert.equal(Object.isFrozen(parsed), true)
  assert.equal(Object.isFrozen(parsed.checkpoint), true)
  assert.throws(() => parseRuntimeReference(ref, 'other-session'), invalid)
})

for (const [name, patch] of Object.entries({
  'wrong kind': { kind: 'local' },
  'wrong version': { version: 2 },
  'wrong OMP': { ompVersion: '18.10.30' },
  'uppercase binding': { bindingHash: 'A'.repeat(64) },
  'bad identifier': { hostProfileId: '../host' },
  'nonstring identifier': { projectId: 1 },
  'relative project': { projectRoot: '../project' },
  'tilde runtime': { runtimeRoot: '~/.phi' },
  'parent segment': { runtimeRoot: '/srv/../runtime' },
  'trailing slash': { runtimeRoot: '/srv/runtime/' },
  'root runtime': { runtimeRoot: '/' },
  'control path': { projectRoot: '/srv/\nproject' },
  'journal traversal': { journalBasename: '../history.jsonl' },
  'journal double dot': { journalBasename: 'history..jsonl' },
  'bad OMP id': { ompSessionId: '/session' },
  'key cross scope': { durableSessionKey: 'a'.repeat(64) + '/phi-1' },
  'secret token': { proxyToken: 'secret' },
  'ephemeral port': { port: 32123 },
  'generation authority': { generation: 'old-generation' },
  'checkpoint secret': {
    checkpoint: { leafId: null, verifiedAt: '2026-10-13T08:00:00Z', token: 'secret' }
  },
  'checkpoint invalid timestamp': { checkpoint: { leafId: null, verifiedAt: 'invalid' } },
  'checkpoint path ID': { checkpoint: { leafId: '../entry', verifiedAt: '2026-10-13T08:00:00Z' } }
})) {
  test(`unknown locator rejects ${name}`, () => {
    assert.throws(
      () => parseRuntimeReference({ ...remoteReference('phi-1'), ...patch }, 'phi-1'),
      invalid
    )
  })
}

test('scope comparison distinguishes host changes and project/root changes', () => {
  const ref = remoteReference('phi-1')
  for (const key of [
    'hostProfileId',
    'bindingHash',
    'projectId',
    'projectRoot',
    'runtimeRoot'
  ] as const) {
    assert.throws(
      () => assertRuntimeScope(ref, { ...remoteReferenceScope, [key]: 'changed' }),
      (error: unknown) =>
        error instanceof RuntimeReferenceError &&
        error.code ===
          (key === 'hostProfileId' || key === 'bindingHash'
            ? 'HOST_IDENTITY_CHANGED'
            : 'PROJECT_MISMATCH')
    )
  }
  assertRuntimeScope(ref, remoteReferenceScope)
})

test('verified adoption preserves local timeline, stable identity, model and concurrent summary writes', () => {
  fixture((session) => {
    const lease = beginRuntimeReferenceAdoption(
      session.sessionId,
      remoteReferenceScope,
      'generation-1',
      {
        expectedOmpSessionId: 'omp-session-1',
        expectedJournalBasename: remoteReference(session.sessionId).journalBasename
      }
    )
    const event = appendSessionEvent(session.sessionId, {
      type: 'user_message',
      content: 'offline evidence'
    })
    updateSessionManifest(session.sessionId, { title: 'Renamed while server publication waits' })
    const adopted = lease.adopt(remoteReference(session.sessionId))
    assert.equal(adopted.sessionId, session.sessionId)
    assert.equal(adopted.cwd, '/desktop/anchor')
    assert.equal(adopted.title, 'Renamed while server publication waits')
    assert.deepEqual(adopted.model, { providerId: 'fixture', modelId: 'selected' })
    assert.equal(adopted.messageCount, 1)
    assert.deepEqual(readSessionEvents(session.sessionId), [event])
    assert.deepEqual(adopted.runtimeRef?.checkpoint, remoteReference(session.sessionId).checkpoint)
    assert.equal(statSync(join(session.dir, 'manifest.json')).mode & 0o777, 0o600)
    assert.equal(adopted.runtimeSessionPath, undefined)
    assert.throws(() => lease.adopt(remoteReference(session.sessionId)), /旧连接/)
  })
})

test('adoption rejects a different host/project/root/session and unexpected OMP identity', () => {
  fixture((session) => {
    for (const key of [
      'hostProfileId',
      'bindingHash',
      'projectId',
      'projectRoot',
      'runtimeRoot'
    ] as const) {
      const lease = beginRuntimeReferenceAdoption(session.sessionId, remoteReferenceScope, key)
      const scope = {
        ...remoteReferenceScope,
        [key]:
          key === 'bindingHash' ? 'c'.repeat(64) : key.endsWith('Root') ? '/other/root' : 'other-id'
      }
      assert.throws(
        () =>
          lease.adopt({
            ...remoteReference(session.sessionId),
            ...scope,
            durableSessionKey: remoteOmpDurableSessionKey(scope, session.sessionId)
          }),
        RuntimeReferenceError
      )
      lease.release()
    }
    const lease = beginRuntimeReferenceAdoption(
      session.sessionId,
      remoteReferenceScope,
      'expected',
      {
        expectedOmpSessionId: 'expected-session',
        expectedJournalBasename: 'expected.jsonl'
      }
    )
    assert.throws(() => lease.adopt(remoteReference(session.sessionId)), /标识或检查点/)
    assert.throws(() => lease.adopt(remoteReference('different-phi-id')), invalid)
    assert.equal(findPhiSessionById(session.sessionId)?.runtimeRef, undefined)
    lease.release()
  })
})

test('late old generations cannot adopt after successor cancellation or release', () => {
  fixture((session) => {
    const old = beginRuntimeReferenceAdoption(session.sessionId, remoteReferenceScope, 'old')
    const controller = new AbortController()
    const next = beginRuntimeReferenceAdoption(session.sessionId, remoteReferenceScope, 'new', {
      signal: controller.signal
    })
    controller.abort()
    next.release()
    assert.throws(() => old.adopt(remoteReference(session.sessionId)), /旧连接/)
    assert.throws(() => next.adopt(remoteReference(session.sessionId)), /已取消/)
    assert.equal(findPhiSessionById(session.sessionId)?.runtimeRef, undefined)
    const newest = beginRuntimeReferenceAdoption(session.sessionId, remoteReferenceScope, 'newest')
    newest.adopt(remoteReference(session.sessionId))
    old.release()
    assert.equal(findPhiSessionById(session.sessionId)?.runtimeRef?.ompSessionId, 'omp-session-1')
  })
})

test('pre-aborted replacement invalidates prior generation and never writes a locator', () => {
  fixture((session) => {
    const old = beginRuntimeReferenceAdoption(session.sessionId, remoteReferenceScope, 'old')
    const cancelled = beginRuntimeReferenceAdoption(
      session.sessionId,
      remoteReferenceScope,
      'cancelled',
      { signal: AbortSignal.abort() }
    )
    assert.throws(() => cancelled.adopt(remoteReference(session.sessionId)), /已取消/)
    assert.throws(() => old.adopt(remoteReference(session.sessionId)), /旧连接/)
    cancelled.release()
    old.release()
  })
})

test('later checkpoint adoption cannot replace the original OMP session or journal', () => {
  fixture((session) => {
    beginRuntimeReferenceAdoption(session.sessionId, remoteReferenceScope, 'initial').adopt(
      remoteReference(session.sessionId)
    )
    const lease = beginRuntimeReferenceAdoption(
      session.sessionId,
      remoteReferenceScope,
      'checkpoint'
    )
    assert.throws(
      () => lease.adopt({ ...remoteReference(session.sessionId), ompSessionId: 'other' }),
      /标识或检查点/
    )
    assert.throws(
      () => lease.adopt({ ...remoteReference(session.sessionId), journalBasename: 'other.jsonl' }),
      /标识或检查点/
    )
    const checkpoint = {
      leafId: null,
      lastEntryId: 'entry-2',
      verifiedAt: '2026-10-13T09:00:00.000Z'
    }
    lease.adopt({ ...remoteReference(session.sessionId), checkpoint })
    assert.deepEqual(findPhiSessionById(session.sessionId)?.runtimeRef?.checkpoint, checkpoint)
    assert.throws(
      () => updateSessionManifest(session.sessionId, { projectId: 'other-project' }),
      /绑定不一致/
    )
  })
})

test('failed atomic replacement preserves the prior manifest and cleans the private temporary file', () => {
  fixture((session) => {
    const path = join(session.dir, 'manifest.json')
    const before = readFileSync(path)
    const lease = beginRuntimeReferenceAdoption(
      session.sessionId,
      remoteReferenceScope,
      'write-failure'
    )
    const rename = mock.method(fs, 'renameSync', () => {
      throw new Error('simulated rename failure')
    })
    syncBuiltinESMExports()
    try {
      assert.throws(
        () => lease.adopt(remoteReference(session.sessionId)),
        /simulated rename failure/
      )
      assert.deepEqual(readFileSync(path), before)
      assert.equal(
        readdirSync(session.dir).some((name) => name.startsWith('.manifest.')),
        false
      )
    } finally {
      rename.mock.restore()
      syncBuiltinESMExports()
    }
    lease.adopt(remoteReference(session.sessionId))
    assert.equal(findPhiSessionById(session.sessionId)?.runtimeRef?.ompSessionId, 'omp-session-1')
  })
})

test('malformed locator stays visible, retains raw disk data and timeline during rename/append', () => {
  fixture((session) => {
    const path = join(session.dir, 'manifest.json')
    const raw = { kind: 'remote-omp', version: 900, proxyToken: 'fixture-secret' }
    writeFileSync(path, JSON.stringify({ ...session.manifest, runtimeRef: raw }))
    const read = findPhiSessionById(session.sessionId)
    assert.equal(read?.runtimeRef, undefined)
    assert.equal(read?.runtimeRecoveryError?.code, 'INVALID_RUNTIME_REFERENCE')
    assert.equal(JSON.stringify(read).includes('fixture-secret'), false)
    updateSessionManifest(session.sessionId, { title: 'Still accessible' })
    appendSessionEvent(session.sessionId, { type: 'user_message', content: 'retained' })
    const disk = JSON.parse(readFileSync(path, 'utf8'))
    assert.deepEqual(disk.runtimeRef, raw)
    assert.equal(disk.runtimeRecoveryError, undefined)
    assert.equal(readSessionEvents(session.sessionId)[0].content, 'retained')
    assert.equal(listPhiSessions()[0].runtimeRecoveryError?.code, 'INVALID_RUNTIME_REFERENCE')
    assert.throws(
      () => beginRuntimeReferenceAdoption(session.sessionId, remoteReferenceScope, 'no-fallback'),
      RuntimeReferenceError
    )
  })
})

for (const [name, patch, expectedCode] of [
  ['project', { projectId: 'other-project' }, 'PROJECT_MISMATCH'],
  [
    'host',
    {
      projectLocation: {
        kind: 'ssh',
        hostProfileId: 'other-host',
        remoteRoot: remoteReferenceScope.projectRoot,
        canonicalRoot: remoteReferenceScope.projectRoot
      }
    },
    'HOST_IDENTITY_CHANGED'
  ],
  [
    'root',
    {
      projectLocation: {
        kind: 'ssh',
        hostProfileId: remoteReferenceScope.hostProfileId,
        remoteRoot: '/other/root',
        canonicalRoot: '/other/root'
      }
    },
    'PROJECT_MISMATCH'
  ]
] as const) {
  test(`stored valid locator with changed ${name} remains recoverable without local fallback`, () => {
    fixture((session) => {
      const path = join(session.dir, 'manifest.json')
      const original = remoteReference(session.sessionId)
      writeFileSync(path, JSON.stringify({ ...session.manifest, runtimeRef: original, ...patch }))
      const read = findPhiSessionById(session.sessionId)
      assert.equal(read?.runtimeRef, undefined)
      assert.equal(read?.runtimeRecoveryError?.code, expectedCode)
      appendSessionEvent(session.sessionId, { type: 'user_message', content: 'history survives' })
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).runtimeRef, original)
      assert.equal(readSessionEvents(session.sessionId)[0].content, 'history survives')
    })
  })
}

test('ordinary or legacy local-runtime sessions cannot adopt a remote locator implicitly', () => {
  fixture((session) => {
    updateSessionManifest(session.sessionId, { runtimeSessionPath: '/desktop/local-runtime.jsonl' })
    assert.throws(
      () => beginRuntimeReferenceAdoption(session.sessionId, remoteReferenceScope, 'wrong-backend'),
      /绑定不一致/
    )
    assert.equal(
      findPhiSessionById(session.sessionId)?.runtimeSessionPath,
      '/desktop/local-runtime.jsonl'
    )
    updateSessionManifest(session.sessionId, { runtimeSessionPath: undefined, kind: 'ordinary' })
    assert.throws(
      () => beginRuntimeReferenceAdoption(session.sessionId, remoteReferenceScope, 'ordinary'),
      /绑定不一致/
    )
  })
})

test('unverified runtime fields cannot be patched through the generic summary updater', () => {
  fixture((session) => {
    const patch = { title: 'must not write', runtimeRef: remoteReference(session.sessionId) }
    assert.throws(() => updateSessionManifest(session.sessionId, patch), /verified adoption/)
    assert.equal(findPhiSessionById(session.sessionId)?.title, 'Remote task')
  })
})

test('anchor relocation during server proof rejects the late desktop adoption', () => {
  fixture((session) => {
    const lease = beginRuntimeReferenceAdoption(
      session.sessionId,
      remoteReferenceScope,
      'before-relocation'
    )
    updateSessionManifest(session.sessionId, {
      cwd: '/desktop/other-anchor',
      cwdRealPath: '/desktop/other-anchor'
    })
    assert.throws(() => lease.adopt(remoteReference(session.sessionId)), /标识或检查点/)
    assert.equal(findPhiSessionById(session.sessionId)?.runtimeRef, undefined)
    assert.equal(findPhiSessionById(session.sessionId)?.cwd, '/desktop/other-anchor')
    lease.release()
  })
})

for (const damage of ['version', 'project', 'host', 'binding', 'secret'] as const) {
  test(`damaged remote locator (${damage}) still excludes raw local IO without a legacy path`, async () => {
    await withRemoteReferenceSession(async (session) => {
      const scope = { ...remoteReferenceScope, runtimeRoot: join(session.dir, 'server-runtime') }
      const ref = {
        ...remoteReference(session.sessionId),
        ...scope,
        durableSessionKey: remoteOmpDurableSessionKey(scope, session.sessionId)
      }
      beginRuntimeReferenceAdoption(session.sessionId, scope, 'valid-before-damage').adopt(ref)
      const remotePath = remoteOmpJournalPath(ref)
      mkdirSync(dirname(remotePath), { recursive: true })
      writeFileSync(remotePath, 'unrelated same-text desktop file')
      const manifestPath = join(session.dir, 'manifest.json')
      const raw = JSON.parse(readFileSync(manifestPath, 'utf8'))
      assert.equal(raw.runtimeSessionPath, undefined)
      if (damage === 'version') raw.runtimeRef.version = 999
      if (damage === 'project') raw.projectId = 'changed-project'
      if (damage === 'host') raw.projectLocation.hostProfileId = 'changed-host'
      if (damage === 'binding') raw.runtimeRef.bindingHash = 'c'.repeat(64)
      if (damage === 'secret') raw.runtimeRef.proxyToken = 'synthetic-private-value'
      writeFileSync(manifestPath, JSON.stringify(raw))
      const publicManifest = findPhiSessionById(session.sessionId)
      assert.equal(publicManifest?.runtimeRef, undefined)
      assert.ok(publicManifest?.runtimeRecoveryError)
      assert.equal(JSON.stringify(publicManifest).includes('synthetic-private-value'), false)
      await renameSession(phiOnlySessionPath(session.sessionId), 'offline title after damage')
      appendSessionEvent(session.sessionId, {
        type: 'user_message',
        content: 'retained offline timeline'
      })
      assert.deepEqual(JSON.parse(readFileSync(manifestPath, 'utf8')).runtimeRef, raw.runtimeRef)
      assert.equal(readSessionEvents(session.sessionId)[0].content, 'retained offline timeline')
      for (const path of [remotePath, remotePath.replace('/journals/', '/journals/../journals/')]) {
        assert.throws(() => deleteSession(path), /需要显式恢复/)
        assert.throws(() => createSessionManager('/desktop/anchor', path), /需要显式恢复/)
        await assert.rejects(renameSession(path, 'must not call desktop SDK'), /需要显式恢复/)
        assert.equal(readFileSync(remotePath, 'utf8'), 'unrelated same-text desktop file')
      }
      await assert.rejects(exportPhiSession(session.sessionId, session.dir), /需要显式恢复/)
      assert.equal(readFileSync(remotePath, 'utf8'), 'unrelated same-text desktop file')
      assert.equal(findPhiSessionById(session.sessionId)?.runtimeRef, undefined)
      assert.throws(
        () => beginRuntimeReferenceAdoption(session.sessionId, scope, 'must-not-restore'),
        RuntimeReferenceError
      )
    })
  })
}
