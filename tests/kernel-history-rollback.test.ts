import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import {
  readKernelOwner,
  rollbackAdoptedSession,
  writeKernelOwner,
  type RollbackPauseStep
} from '../src/main/agent/engine/kernel-history'
import { resolveBunExecutable } from '../src/main/agent/engine/bun-executable'
import { readManifestFile, writeManifestFile } from '../src/main/agent/session/manifest-file'
import type { PhiSessionManifest } from '../src/main/agent/session/session-store'

const NOW = new Date('2026-10-26T01:02:03.456Z')
const COMPATIBILITY = {
  kernelSdkVersion: '18.10.3',
  oldAppSdkVersion: '18.10.3',
  oldAppJournalVersion: 3
} as const

interface Fixture {
  root: string
  cwd: string
  phiDirectory: string
  originalJournal: string
  runtimeRoot: string
  kernelJournal: string
  originalBytes: Buffer
  originalManifestBytes: Buffer
}

function inspectJournal(path: string, cwd: string, agentDir: string): { sessionId: string } {
  const script = [
    "import { makeSessionManager } from './src/main/agent/engine/in-process/session-factory'",
    'const { PROBE_PATH: path, PROBE_CWD: cwd, PROBE_AGENT_DIR: agentDir } = process.env',
    "const manager = await makeSessionManager({ kind: 'open', path, requireExisting: true, suppressBreadcrumb: true }, cwd, agentDir)",
    'const result = { sessionId: manager.getSessionId() }',
    'await manager.close()',
    'console.log(JSON.stringify(result))'
  ].join('\n')
  const stdout = execFileSync(resolveBunExecutable(), ['-e', script], {
    cwd: resolve('.'),
    encoding: 'utf8',
    env: {
      ...process.env,
      PROBE_PATH: path,
      PROBE_CWD: cwd,
      PROBE_AGENT_DIR: agentDir
    },
    stdio: ['ignore', 'pipe', 'inherit']
  })
  return JSON.parse(stdout.trim()) as { sessionId: string }
}

function journal(cwd: string, id: string, message: string): string {
  return (
    [
      JSON.stringify({
        type: 'session',
        version: 3,
        id,
        timestamp: '2026-10-25T00:00:00.000Z',
        cwd
      }),
      JSON.stringify({
        type: 'message',
        id: `${id}-message`,
        parentId: null,
        timestamp: '2026-10-25T00:01:00.000Z',
        message: { role: 'user', content: message, timestamp: 1 }
      })
    ].join('\n') + '\n'
  )
}

function makeFixture(name: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), `phi-history-rollback-${name}-`))
  const cwd = join(root, 'project')
  const phiDirectory = join(root, 'phi-session')
  const originalJournal = join(root, 'original.jsonl')
  const runtimeRoot = join(root, 'agent')
  const kernelJournal = join(
    runtimeRoot,
    'phi-kernel',
    'sessions',
    'kernel-session',
    'journal.jsonl'
  )
  mkdirSync(cwd)
  mkdirSync(phiDirectory)
  mkdirSync(join(runtimeRoot, 'phi-kernel', 'sessions', 'kernel-session'), { recursive: true })
  const originalBytes = Buffer.from(journal(cwd, 'old-session', 'before migration'))
  writeFileSync(originalJournal, originalBytes, { mode: 0o600 })
  utimesSync(originalJournal, new Date('2025-01-01T00:00:00Z'), new Date('2025-01-01T00:00:00Z'))
  writeFileSync(kernelJournal, journal(cwd, 'old-session', 'latest kernel result'), {
    mode: 0o600
  })
  const manifest: PhiSessionManifest = {
    schemaVersion: 1,
    sessionId: 'phi-session',
    kind: 'ordinary',
    projectId: null,
    cwd,
    cwdRealPath: cwd,
    runtimeSessionPath: originalJournal,
    permissionMode: 'auto',
    status: 'idle',
    unreadKind: null,
    messageCount: 1,
    createdAt: '2026-10-25T00:00:00.000Z',
    updatedAt: '2026-10-25T00:00:00.000Z',
    lastActivityAt: '2026-10-25T00:00:00.000Z'
  }
  writeManifestFile(phiDirectory, manifest)
  const originalManifestBytes = readFileSync(join(phiDirectory, 'manifest.json'))
  writeFileSync(join(phiDirectory, 'unrelated-sentinel'), 'untouched')
  return {
    root,
    cwd,
    phiDirectory,
    originalJournal,
    runtimeRoot,
    kernelJournal,
    originalBytes,
    originalManifestBytes
  }
}

async function own(
  fixture: Fixture,
  overrides: Partial<Parameters<typeof writeKernelOwner>[1]> = {}
): Promise<void> {
  await writeKernelOwner(fixture.phiDirectory, {
    schemaVersion: 1,
    kernelSessionId: 'kernel-session',
    host: 'local-host',
    runtimeRoot: fixture.runtimeRoot,
    migratedAt: '2026-10-25T12:00:00.000Z',
    sourceSha256: createHash('sha256').update(fixture.originalBytes).digest('hex'),
    ...overrides
  })
}

function manifest(fixture: Fixture): PhiSessionManifest {
  return readManifestFile(join(fixture.phiDirectory, 'manifest.json'), 'phi-session')
}

test('compatible rollback exports current history, backs up and atomically repoints the manifest', async () => {
  const fixture = makeFixture('compatible')
  await own(fixture)
  const originalMtime = statSync(fixture.originalJournal).mtimeMs
  try {
    const result = await rollbackAdoptedSession({
      phiSessionDirectory: fixture.phiDirectory,
      originalRuntimeSessionPath: fixture.originalJournal,
      kernelJournalPath: fixture.kernelJournal,
      compatibility: COMPATIBILITY,
      now: () => NOW
    })
    assert.equal(result.status, 'rolled-back')
    if (result.status !== 'rolled-back') return
    assert.equal(result.exportPath, `${fixture.originalJournal}.kernel-20261026T010203456Z.jsonl`)
    assert.deepEqual(readFileSync(result.exportPath), readFileSync(fixture.kernelJournal))
    assert.deepEqual(readFileSync(fixture.originalJournal), fixture.originalBytes)
    assert.equal(statSync(fixture.originalJournal).mtimeMs, originalMtime)
    assert.deepEqual(
      readFileSync(join(fixture.phiDirectory, 'manifest.json.pre-rollback')),
      fixture.originalManifestBytes
    )
    assert.equal(manifest(fixture).runtimeSessionPath, result.exportPath)
    assert.equal(existsSync(join(fixture.phiDirectory, 'kernel-owner.json')), false)
    assert.equal(
      readFileSync(join(fixture.phiDirectory, 'unrelated-sentinel'), 'utf8'),
      'untouched'
    )

    const reopened = inspectJournal(
      result.exportPath,
      fixture.cwd,
      join(fixture.root, 'old-app-agent')
    )
    assert.equal(reopened.sessionId, 'old-session')
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('incompatible rollback leaves ownership read-only and changes neither journal nor manifest', async () => {
  const fixture = makeFixture('incompatible')
  await own(fixture)
  try {
    const result = await rollbackAdoptedSession({
      phiSessionDirectory: fixture.phiDirectory,
      originalRuntimeSessionPath: fixture.originalJournal,
      kernelJournalPath: fixture.kernelJournal,
      compatibility: { ...COMPATIBILITY, oldAppSdkVersion: '17.0.0' },
      now: () => NOW
    })
    assert.equal(result.status, 'incompatible')
    const owner = await readKernelOwner(fixture.phiDirectory)
    assert.equal(owner?.readOnly, true)
    assert.equal(owner?.reason, result.reason)
    assert.match(owner?.reason ?? '', /SDK 18\.10\.3 does not match old app SDK 17\.0\.0/)
    assert.deepEqual(readFileSync(fixture.originalJournal), fixture.originalBytes)
    assert.deepEqual(
      readFileSync(join(fixture.phiDirectory, 'manifest.json')),
      fixture.originalManifestBytes
    )
    assert.equal(existsSync(join(fixture.phiDirectory, 'manifest.json.pre-rollback')), false)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('rollback rejects journals and sources that do not match the recorded owner', async () => {
  const foreignPath = makeFixture('foreign-path')
  await own(foreignPath)
  const foreignJournal = join(foreignPath.root, 'foreign.jsonl')
  writeFileSync(foreignJournal, journal(foreignPath.cwd, 'foreign-session', 'unrelated history'), {
    mode: 0o600
  })
  try {
    await assert.rejects(
      rollbackAdoptedSession({
        phiSessionDirectory: foreignPath.phiDirectory,
        originalRuntimeSessionPath: foreignPath.originalJournal,
        kernelJournalPath: foreignJournal,
        compatibility: COMPATIBILITY,
        now: () => NOW
      }),
      /path does not match the recorded owner/i
    )
    assert.deepEqual(
      readFileSync(join(foreignPath.phiDirectory, 'manifest.json')),
      foreignPath.originalManifestBytes
    )
  } finally {
    rmSync(foreignPath.root, { recursive: true, force: true })
  }

  const wrongHash = makeFixture('wrong-source-hash')
  await own(wrongHash, { sourceSha256: '0'.repeat(64) })
  try {
    await assert.rejects(
      rollbackAdoptedSession({
        phiSessionDirectory: wrongHash.phiDirectory,
        originalRuntimeSessionPath: wrongHash.originalJournal,
        kernelJournalPath: wrongHash.kernelJournal,
        compatibility: COMPATIBILITY,
        now: () => NOW
      }),
      /original journal hash does not match/i
    )
  } finally {
    rmSync(wrongHash.root, { recursive: true, force: true })
  }

  const wrongHeader = makeFixture('wrong-header')
  await own(wrongHeader)
  writeFileSync(
    wrongHeader.kernelJournal,
    journal(wrongHeader.cwd, 'unrelated-session', 'unrelated history'),
    { mode: 0o600 }
  )
  try {
    await assert.rejects(
      rollbackAdoptedSession({
        phiSessionDirectory: wrongHeader.phiDirectory,
        originalRuntimeSessionPath: wrongHeader.originalJournal,
        kernelJournalPath: wrongHeader.kernelJournal,
        compatibility: COMPATIBILITY,
        now: () => NOW
      }),
      /journal identity does not match/i
    )
  } finally {
    rmSync(wrongHeader.root, { recursive: true, force: true })
  }

  const wrongManifest = makeFixture('wrong-manifest-path')
  await own(wrongManifest)
  writeManifestFile(wrongManifest.phiDirectory, {
    ...manifest(wrongManifest),
    runtimeSessionPath: join(wrongManifest.root, 'different-original.jsonl')
  })
  try {
    await assert.rejects(
      rollbackAdoptedSession({
        phiSessionDirectory: wrongManifest.phiDirectory,
        originalRuntimeSessionPath: wrongManifest.originalJournal,
        kernelJournalPath: wrongManifest.kernelJournal,
        compatibility: COMPATIBILITY,
        now: () => NOW
      }),
      /manifest runtime path does not match/i
    )
  } finally {
    rmSync(wrongManifest.root, { recursive: true, force: true })
  }
})

for (const pauseAt of [
  'state-started',
  'journal-exported',
  'manifest-backed-up',
  'manifest-repointed'
] as const satisfies readonly RollbackPauseStep[]) {
  test(`rollback resumes after interruption at ${pauseAt} and a later retry is idempotent`, async () => {
    const fixture = makeFixture(pauseAt)
    await own(fixture)
    let paused = false
    try {
      await assert.rejects(
        rollbackAdoptedSession({
          phiSessionDirectory: fixture.phiDirectory,
          originalRuntimeSessionPath: fixture.originalJournal,
          kernelJournalPath: fixture.kernelJournal,
          compatibility: COMPATIBILITY,
          now: () => NOW,
          afterStep(step) {
            if (!paused && step === pauseAt) {
              paused = true
              throw new Error(`simulated crash after ${step}`)
            }
          }
        }),
        new RegExp(`simulated crash after ${pauseAt}`)
      )

      const resumed = await rollbackAdoptedSession({
        phiSessionDirectory: fixture.phiDirectory,
        originalRuntimeSessionPath: fixture.originalJournal,
        kernelJournalPath: fixture.kernelJournal,
        compatibility: COMPATIBILITY,
        now: () => NOW
      })
      assert.equal(resumed.status, 'rolled-back')
      if (resumed.status !== 'rolled-back') return
      assert.equal(resumed.resumed, true)
      assert.deepEqual(readFileSync(resumed.exportPath), readFileSync(fixture.kernelJournal))
      assert.deepEqual(readFileSync(fixture.originalJournal), fixture.originalBytes)

      const idempotent = await rollbackAdoptedSession({
        phiSessionDirectory: fixture.phiDirectory,
        originalRuntimeSessionPath: fixture.originalJournal,
        kernelJournalPath: fixture.kernelJournal,
        compatibility: COMPATIBILITY,
        now: () => NOW
      })
      assert.deepEqual(idempotent, {
        status: 'rolled-back',
        exportPath: resumed.exportPath,
        resumed: true,
        alreadyComplete: true
      })
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })
}
