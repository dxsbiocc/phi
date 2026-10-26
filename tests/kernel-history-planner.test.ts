import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  OLD_REMOTE_PROCESS_REASON,
  planKernelHistory,
  readAndPlanKernelHistory,
  readKernelOwner,
  recordKernelHistoryAdoption,
  writeKernelOwner,
  writeRpcDiagnostics,
  type RemoteHistoryProbeResult
} from '../src/main/agent/engine/kernel-history'
import type { PhiSessionManifest } from '../src/main/agent/session/session-store'
import {
  REMOTE_OMP_VERSION,
  remoteOmpDurableSessionKey,
  type RemoteOmpRuntimeRef,
  type RemoteOmpScope
} from '../src/main/agent/session/runtime-reference'

function baseManifest(sessionId: string, cwd: string): PhiSessionManifest {
  const now = '2026-10-26T01:02:03.000Z'
  return {
    schemaVersion: 1,
    sessionId,
    kind: 'ordinary',
    projectId: null,
    cwd,
    cwdRealPath: cwd,
    permissionMode: 'auto',
    status: 'idle',
    unreadKind: null,
    messageCount: 0,
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now
  }
}

function writeManifest(
  directory: string,
  manifest: PhiSessionManifest | Record<string, unknown>
): void {
  writeFileSync(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600
  })
}

function remoteFixture(root: string): {
  manifest: PhiSessionManifest
  scope: RemoteOmpScope
  ref: RemoteOmpRuntimeRef
  probe: RemoteHistoryProbeResult
} {
  const sessionId = 'remote-session'
  const scope: RemoteOmpScope = {
    hostProfileId: 'ssh-config:node3',
    bindingHash: 'a'.repeat(64),
    projectId: 'project-1',
    projectRoot: '/srv/project',
    runtimeRoot: '/srv/phi-runtime'
  }
  const ref: RemoteOmpRuntimeRef = {
    ...scope,
    kind: 'remote-omp',
    version: 1,
    durableSessionKey: remoteOmpDurableSessionKey(scope, sessionId),
    ompSessionId: 'omp-session-1',
    journalBasename: 'session.jsonl',
    ompVersion: REMOTE_OMP_VERSION
  }
  const manifest: PhiSessionManifest = {
    // As in real RPC-era manifests: cwd is the desktop's local anchor, not the server path.
    ...baseManifest(sessionId, '/Users/test/.phi/remote-project-anchors/project-1'),
    kind: 'project',
    projectId: 'project-1',
    projectLocation: {
      kind: 'ssh',
      hostProfileId: 'ssh-config:node3',
      remoteRoot: '/srv/project',
      canonicalRoot: '/srv/project'
    },
    remoteRuntime: 'rpc',
    runtimeRef: ref
  }
  const probe: RemoteHistoryProbeResult = {
    identity: {
      ...scope,
      phiSessionId: sessionId,
      durableSessionKey: ref.durableSessionKey,
      ompSessionId: ref.ompSessionId,
      journalBasename: ref.journalBasename
    },
    sourcePath: `${root}/downloaded-session.jsonl`,
    sourceSize: 4096,
    sourceSha256: 'b'.repeat(64),
    sourceOmpSessionId: ref.ompSessionId,
    sourceCwd: scope.projectRoot,
    writer: 'gone',
    runLock: 'gone',
    diagnostics: { executionLease: 'expired', extensionHash: 'hash-only' }
  }
  return { manifest, scope, ref, probe }
}

test('planner reads the canonical Phi manifest and adopts a readable local journal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-history-plan-local-'))
  const sessionDirectory = join(root, 'local-session')
  const journal = join(root, 'source.jsonl')
  mkdirSync(sessionDirectory)
  writeFileSync(journal, '{"type":"session"}\n')
  writeManifest(sessionDirectory, {
    ...baseManifest('local-session', root),
    runtimeSessionPath: journal
  })
  try {
    const plan = await readAndPlanKernelHistory({
      phiSessionDirectory: sessionDirectory,
      phiSessionId: 'local-session'
    })
    assert.equal(plan.action, 'adopt-local')
    assert.equal(plan.status, 'ready')
    if (plan.action === 'adopt-local') assert.equal(plan.source.path, journal)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('planner keeps recovery errors and legacy SSH histories read-only', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-history-plan-readonly-'))
  try {
    const brokenDirectory = join(root, 'broken-ref')
    mkdirSync(brokenDirectory)
    writeManifest(brokenDirectory, {
      ...baseManifest('broken-ref', '/srv/project'),
      kind: 'project',
      projectId: 'project-1',
      projectLocation: {
        kind: 'ssh',
        hostProfileId: 'node3',
        remoteRoot: '/srv/project',
        canonicalRoot: '/srv/project'
      },
      runtimeRef: { kind: 'broken' }
    })
    const brokenPlan = await readAndPlanKernelHistory({
      phiSessionDirectory: brokenDirectory,
      phiSessionId: 'broken-ref'
    })
    assert.equal(brokenPlan.action, 'read-only')
    if (brokenPlan.action === 'read-only') {
      assert.equal(brokenPlan.error?.code, 'INVALID_RUNTIME_REFERENCE')
      assert.equal(brokenPlan.reason, brokenPlan.error?.message)
    }

    const legacyDirectory = join(root, 'legacy-ssh')
    mkdirSync(legacyDirectory)
    const legacyJournal = join(root, 'legacy.jsonl')
    writeFileSync(legacyJournal, '{}\n')
    writeManifest(legacyDirectory, {
      ...baseManifest('legacy-ssh', '/srv/project'),
      kind: 'project',
      projectId: 'project-1',
      projectLocation: {
        kind: 'ssh',
        hostProfileId: 'node3',
        remoteRoot: '/srv/project',
        canonicalRoot: '/srv/project'
      },
      runtimeSessionPath: legacyJournal
    })
    const legacyPlan = await readAndPlanKernelHistory({
      phiSessionDirectory: legacyDirectory,
      phiSessionId: 'legacy-ssh'
    })
    assert.deepEqual(
      { action: legacyPlan.action, reason: legacyPlan.reason, status: legacyPlan.status },
      {
        action: 'read-only',
        reason: 'legacy SSH sessions remain read-only',
        status: 'read-only'
      }
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('RPC planner requires matching identities and proof that both old holders are gone', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-history-plan-rpc-'))
  const sessionDirectory = join(root, 'remote-session')
  mkdirSync(sessionDirectory)
  const fixture = remoteFixture(root)
  writeManifest(sessionDirectory, fixture.manifest)
  try {
    const verifiedPlan = await readAndPlanKernelHistory({
      phiSessionDirectory: sessionDirectory,
      phiSessionId: fixture.manifest.sessionId,
      expectedRemoteScope: fixture.scope,
      probeRemoteOwnership: async () => fixture.probe
    })
    assert.equal(verifiedPlan.action, 'adopt-remote')
    if (verifiedPlan.action === 'adopt-remote') {
      assert.equal(verifiedPlan.source.path, fixture.probe.sourcePath)
      assert.equal(verifiedPlan.source.cwd, fixture.scope.projectRoot)
      assert.deepEqual(verifiedPlan.source.expected, {
        sha256: fixture.probe.sourceSha256,
        size: fixture.probe.sourceSize
      })
      assert.deepEqual(verifiedPlan.rpcDiagnostics, fixture.probe.diagnostics)
    }

    for (const sourceMismatch of [
      { sourceOmpSessionId: 'different-session' },
      { sourceCwd: '/srv/other-project' },
      { sourceSha256: 'not-a-hash' },
      { sourceSize: -1 }
    ]) {
      const plan = planKernelHistory({
        manifest: fixture.manifest,
        expectedRemoteScope: fixture.scope,
        remoteProbe: { ...fixture.probe, ...sourceMismatch }
      })
      assert.equal(plan.action, 'read-only')
      assert.equal(plan.reason, 'remote journal identity is inconsistent')
    }

    for (const [name, expectedScope] of [
      ['host', { ...fixture.scope, hostProfileId: 'node4' }],
      ['project', { ...fixture.scope, projectRoot: '/srv/other' }],
      ['runtime root', { ...fixture.scope, runtimeRoot: '/srv/other-runtime' }]
    ] as const) {
      const plan = planKernelHistory({
        manifest: fixture.manifest,
        expectedRemoteScope: expectedScope,
        remoteProbe: fixture.probe
      })
      assert.equal(plan.action, 'read-only', `${name} mismatch action`)
      assert.equal(
        plan.reason,
        'remote session identity is inconsistent',
        `${name} mismatch reason`
      )
    }

    for (const [writer, runLock] of [
      ['held', 'gone'],
      ['gone', 'held'],
      ['unprovable', 'gone'],
      ['gone', 'unprovable']
    ] as const) {
      const manifest: PhiSessionManifest = {
        ...fixture.manifest,
        status: 'running',
        currentRunId: 'interrupted-run',
        lastRunOutcome: 'interrupted'
      }
      const plan = planKernelHistory({
        manifest,
        expectedRemoteScope: fixture.scope,
        remoteProbe: { ...fixture.probe, writer, runLock }
      })
      assert.deepEqual(
        { action: plan.action, reason: plan.reason, status: plan.status },
        { action: 'read-only', reason: OLD_REMOTE_PROCESS_REASON, status: 'unknown' },
        `${writer}/${runLock} ownership proof`
      )
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ownership and RPC diagnostic helpers write companion files without touching the manifest', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-history-owner-'))
  const phiDirectory = join(root, 'phi')
  const kernelDirectory = join(root, 'kernel')
  mkdirSync(phiDirectory)
  mkdirSync(kernelDirectory)
  const manifest = Buffer.from('{"sentinel":"unchanged"}\n')
  writeFileSync(join(phiDirectory, 'manifest.json'), manifest)
  try {
    const sourceSha256 = createHash('sha256').update('source').digest('hex')
    await writeKernelOwner(phiDirectory, {
      schemaVersion: 1,
      kernelSessionId: 'kernel-1',
      host: 'local-host',
      runtimeRoot: '/runtime',
      migratedAt: '2026-10-26T01:02:03.000Z',
      sourceSha256
    })
    assert.equal((await readKernelOwner(phiDirectory))?.sourceSha256, sourceSha256)

    const diagnosticsPath = await writeRpcDiagnostics(
      kernelDirectory,
      { executionLease: { state: 'expired' }, bootstrapProof: 'sha256:abc' },
      '2026-10-26T01:02:03.000Z'
    )
    assert.equal(statSync(diagnosticsPath).mode & 0o777, 0o400)
    assert.deepEqual(JSON.parse(readFileSync(diagnosticsPath, 'utf8')).diagnostics, {
      executionLease: { state: 'expired' },
      bootstrapProof: 'sha256:abc'
    })
    assert.deepEqual(readFileSync(join(phiDirectory, 'manifest.json')), manifest)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('remote adoption publishes diagnostics before the owner claim', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-history-owner-order-'))
  const phiDirectory = join(root, 'phi')
  const kernelDirectory = join(root, 'kernel')
  mkdirSync(phiDirectory)
  mkdirSync(kernelDirectory)
  const fixture = remoteFixture(root)
  const plan = planKernelHistory({
    manifest: fixture.manifest,
    expectedRemoteScope: fixture.scope,
    remoteProbe: fixture.probe
  })
  assert.equal(plan.action, 'adopt-remote')
  if (plan.action !== 'adopt-remote') return
  try {
    const recorded = await recordKernelHistoryAdoption({
      plan,
      phiSessionDirectory: phiDirectory,
      adoptedSessionDirectory: kernelDirectory,
      kernelSessionId: 'kernel-session',
      host: 'node3',
      runtimeRoot: '/srv/phi-runtime',
      sourceSha256: fixture.probe.sourceSha256,
      migratedAt: '2026-10-26T01:02:03.000Z'
    })
    assert.equal(recorded.owner.kernelSessionId, 'kernel-session')
    assert.equal(statSync(recorded.rpcDiagnosticsPath as string).mode & 0o777, 0o400)

    const failedPhi = join(root, 'failed-phi')
    const failedKernel = join(root, 'failed-kernel')
    mkdirSync(failedPhi)
    mkdirSync(failedKernel)
    await assert.rejects(
      recordKernelHistoryAdoption({
        plan: { ...plan, rpcDiagnostics: { notJson: 1n } },
        phiSessionDirectory: failedPhi,
        adoptedSessionDirectory: failedKernel,
        kernelSessionId: 'kernel-session',
        host: 'node3',
        runtimeRoot: '/srv/phi-runtime',
        sourceSha256: fixture.probe.sourceSha256
      })
    )
    assert.equal(await readKernelOwner(failedPhi), undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
