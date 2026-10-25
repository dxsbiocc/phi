import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'

import { resolveBunExecutable } from '../src/main/agent/engine/bun-executable'
import type { SessionAdoptParams } from '../src/shared/kernel-protocol/history'

const {
  KernelSessionRepository,
  SessionWriterBusyError,
  adoptedSessionId,
  kernelSessionMigrationPaths,
  readMigration
} = await import('../src/kernel/sessions')

type Fixture = {
  root: string
  cwd: string
  sourceRoot: string
  source: string
  agentDir: string
}

type ManagerProbeResult = {
  cwd: string
  messageCount: number
  sessionId: string
}

function runManagerProbe(
  operation: 'create' | 'open',
  path: string,
  cwd: string,
  agentDir: string
): ManagerProbeResult {
  const script = [
    "import { makeSessionManager } from './src/main/agent/engine/in-process/session-factory'",
    'const { PROBE_OPERATION: operation, PROBE_PATH: path, PROBE_CWD: cwd, PROBE_AGENT_DIR: agentDir } = process.env',
    "const manager = await makeSessionManager(operation === 'create' ? { kind: 'persistent', path } : { kind: 'open', path, requireExisting: true, suppressBreadcrumb: true }, cwd, agentDir)",
    "if (operation === 'create') manager.appendMessage({ role: 'user', content: 'historic prompt', timestamp: Date.now() })",
    'const result = { cwd: manager.getCwd(), messageCount: manager.buildSessionContext().messages.length, sessionId: manager.getSessionId() }',
    'await manager.close()',
    'console.log(JSON.stringify(result))'
  ].join('\n')
  const stdout = execFileSync(resolveBunExecutable(), ['-e', script], {
    cwd: resolve('.'),
    encoding: 'utf8',
    env: {
      ...process.env,
      PROBE_OPERATION: operation,
      PROBE_PATH: path,
      PROBE_CWD: cwd,
      PROBE_AGENT_DIR: agentDir
    },
    stdio: ['ignore', 'pipe', 'inherit']
  })
  return JSON.parse(stdout.trim()) as ManagerProbeResult
}

async function fixture(name: string): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), `phi-history-${name}-`))
  const cwd = join(root, 'project')
  const sourceRoot = join(root, 'source')
  const source = join(sourceRoot, 'history.jsonl')
  const agentDir = join(root, 'agent')
  mkdirSync(cwd)
  mkdirSync(sourceRoot)
  mkdirSync(dirname(source), { recursive: true })
  runManagerProbe('create', source, cwd, agentDir)
  return { root, cwd, sourceRoot, source, agentDir }
}

function params(value: Fixture): SessionAdoptParams {
  return {
    source: {
      kind: 'omp-journal',
      path: value.source,
      cwd: value.cwd,
      origin: 'desktop-local',
      phiSessionId: 'phi-session-1'
    },
    title: 'Adopted history',
    model: { provider: 'test-provider', id: 'test-model' },
    thinkingLevel: 'high'
  }
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function repository(
  agentDir: string,
  instance: string
): InstanceType<typeof KernelSessionRepository> {
  return new KernelSessionRepository(
    agentDir,
    instance,
    undefined,
    'test-process',
    async (path, cwd) => {
      runManagerProbe('open', path, cwd, agentDir)
    }
  )
}

test('adoption preserves the source, records the migration, and is idempotent', async () => {
  const value = await fixture('complete')
  const repo = repository(value.agentDir, 'adopt-complete')
  const before = statSync(value.source)
  const original = readFileSync(value.source)
  try {
    const first = await repo.adopt(params(value), { allowedSourceRoots: [value.sourceRoot] })
    const paths = kernelSessionMigrationPaths(value.agentDir, first.sessionId)
    assert.equal(first.migration.state, 'complete')
    assert.deepEqual(readFileSync(value.source), original)
    assert.equal(statSync(value.source).mtimeMs, before.mtimeMs)
    assert.deepEqual(readFileSync(paths.sourceBackup), original)
    assert.deepEqual(readFileSync(paths.journal), original)
    const opened = await repo.open(first.sessionId)
    assert.equal(opened.manifest.title, 'Adopted history')
    assert.deepEqual(opened.manifest.model, {
      provider: 'test-provider',
      id: 'test-model'
    })
    assert.equal(opened.manifest.thinkingLevel, 'high')
    assert.deepEqual(await readMigration(paths.migration), {
      ...(await readMigration(paths.migration)),
      state: 'complete',
      backup: 'source-backup.jsonl'
    })

    const reopened = runManagerProbe('open', paths.journal, value.cwd, value.agentDir)
    assert.equal(reopened.messageCount, 1)

    const second = await repo.adopt(params(value), { allowedSourceRoots: [value.sourceRoot] })
    assert.equal(second.sessionId, first.sessionId)
    assert.equal((await repo.list()).sessions.length, 1)
  } finally {
    await Promise.all(
      (await repo.list()).sessions.map((entry) => repo.close(entry.sessionId))
    ).catch(() => undefined)
    rmSync(value.root, { recursive: true, force: true })
  }
})

test('adoption rejects symlinks, paths outside trusted roots, and expected hash mismatches', async () => {
  const value = await fixture('validation')
  const repo = repository(value.agentDir, 'adopt-validation')
  try {
    const link = join(value.sourceRoot, 'linked.jsonl')
    symlinkSync(value.source, link)
    await assert.rejects(
      repo.adopt(
        { ...params(value), source: { ...params(value).source, path: link } },
        { allowedSourceRoots: [value.sourceRoot] }
      ),
      /regular file.*symlink/i
    )
    const outside = join(value.root, 'outside')
    const linkedParent = join(value.sourceRoot, 'linked-parent')
    mkdirSync(outside)
    writeFileSync(join(outside, 'history.jsonl'), readFileSync(value.source))
    symlinkSync(outside, linkedParent)
    await assert.rejects(
      repo.adopt(
        {
          ...params(value),
          source: { ...params(value).source, path: join(linkedParent, 'history.jsonl') }
        },
        { allowedSourceRoots: [value.sourceRoot] }
      ),
      /outside the allowed roots/i
    )
    await assert.rejects(
      repo.adopt(params(value), { allowedSourceRoots: [join(value.root, 'project')] }),
      /outside the allowed roots/i
    )
    await assert.rejects(
      repo.adopt(
        {
          ...params(value),
          source: {
            ...params(value).source,
            expected: { sha256: '0'.repeat(64), size: statSync(value.source).size }
          }
        },
        { allowedSourceRoots: [value.sourceRoot] }
      ),
      /expected hash/i
    )
  } finally {
    rmSync(value.root, { recursive: true, force: true })
  }
})

for (const state of ['started', 'copied', 'verified', 'complete'] as const) {
  test(`a migration interrupted after ${state} resumes without creating a second session`, async () => {
    const value = await fixture(`resume-${state}`)
    const sourceSha256 = sha256(value.source)
    const sessionId = adoptedSessionId('phi-session-1', sourceSha256)
    const first = repository(value.agentDir, `before-${state}`)
    const second = repository(value.agentDir, `after-${state}`)
    let interrupted = false
    try {
      await assert.rejects(
        first.adopt(params(value), {
          allowedSourceRoots: [value.sourceRoot],
          pauseAfterState(point) {
            if (point !== state || interrupted) return
            interrupted = true
            throw new Error(`simulated crash after ${point}`)
          }
        }),
        /simulated crash/
      )
      const listed = await first.list()
      if (state === 'complete') {
        assert.equal('error' in listed.sessions[0]!, false)
      } else {
        assert.match(
          'error' in listed.sessions[0]! ? listed.sessions[0].error.message : '',
          new RegExp(`incomplete at state ${state}`)
        )
      }

      if (state !== 'verified') {
        const resumed = await second.adopt(params(value), {
          allowedSourceRoots: [value.sourceRoot]
        })
        assert.equal(resumed.sessionId, sessionId)
      }
      assert.equal((await second.open(sessionId)).manifest.sessionId, sessionId)
      assert.equal((await second.list()).sessions.length, 1)
      assert.equal(
        (await readMigration(kernelSessionMigrationPaths(value.agentDir, sessionId).migration))
          ?.state,
        'complete'
      )
    } finally {
      await first.close(sessionId)
      await second.close(sessionId)
      rmSync(value.root, { recursive: true, force: true })
    }
  })
}

test('a started migration refreshes metadata when unchanged source bytes are touched', async () => {
  const value = await fixture('resume-touched-source')
  const sourceSha256 = sha256(value.source)
  const sessionId = adoptedSessionId('phi-session-1', sourceSha256)
  const before = repository(value.agentDir, 'before-touch')
  const after = repository(value.agentDir, 'after-touch')
  try {
    await assert.rejects(
      before.adopt(params(value), {
        allowedSourceRoots: [value.sourceRoot],
        pauseAfterState(state) {
          if (state === 'started') throw new Error('simulated crash before copy')
        }
      }),
      /simulated crash/
    )
    const touchedAt = new Date(Date.now() + 5_000)
    utimesSync(value.source, touchedAt, touchedAt)

    const resumed = await after.adopt(params(value), {
      allowedSourceRoots: [value.sourceRoot]
    })
    assert.equal(resumed.sessionId, sessionId)
    assert.equal(
      (await readMigration(kernelSessionMigrationPaths(value.agentDir, sessionId).migration))
        ?.state,
      'complete'
    )
  } finally {
    await before.close(sessionId)
    await after.close(sessionId)
    rmSync(value.root, { recursive: true, force: true })
  }
})

test('a changed source rolls back its obsolete started target before adopting new bytes', async () => {
  const value = await fixture('rollback-changed-source')
  const oldSessionId = adoptedSessionId('phi-session-1', sha256(value.source))
  const before = repository(value.agentDir, 'before-source-change')
  const after = repository(value.agentDir, 'after-source-change')
  try {
    await assert.rejects(
      before.adopt(params(value), {
        allowedSourceRoots: [value.sourceRoot],
        pauseAfterState(state) {
          if (state === 'started') throw new Error('simulated crash before changed source')
        }
      }),
      /simulated crash/
    )
    appendFileSync(
      value.source,
      `${JSON.stringify({
        type: 'custom',
        id: 'changed-source-entry',
        parentId: null,
        timestamp: new Date().toISOString(),
        customType: 'changed-source',
        data: { changed: true }
      })}\n`
    )

    await assert.rejects(before.open(oldSessionId), (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT')
      return true
    })
    assert.equal(
      existsSync(kernelSessionMigrationPaths(value.agentDir, oldSessionId).directory),
      false
    )

    const adopted = await after.adopt(params(value), {
      allowedSourceRoots: [value.sourceRoot]
    })
    assert.notEqual(adopted.sessionId, oldSessionId)
    assert.deepEqual(
      (await after.list()).sessions.map((entry) => entry.sessionId),
      [adopted.sessionId]
    )
  } finally {
    await before.close(oldSessionId)
    for (const entry of (await after.list()).sessions) await after.close(entry.sessionId)
    rmSync(value.root, { recursive: true, force: true })
  }
})

test('adopt directly removes a superseded started target for the same Phi source', async () => {
  const value = await fixture('adopt-changed-source-directly')
  const oldSessionId = adoptedSessionId('phi-session-1', sha256(value.source))
  const first = repository(value.agentDir, 'direct-change-first')
  const second = repository(value.agentDir, 'direct-change-second')
  try {
    await assert.rejects(
      first.adopt(params(value), {
        allowedSourceRoots: [value.sourceRoot],
        pauseAfterState(state) {
          if (state === 'started') throw new Error('simulated direct-adopt crash')
        }
      }),
      /simulated direct-adopt crash/
    )
    appendFileSync(
      value.source,
      `${JSON.stringify({
        type: 'custom',
        id: 'direct-change-entry',
        parentId: null,
        timestamp: new Date().toISOString(),
        customType: 'changed-source',
        data: { changed: true }
      })}\n`
    )

    const adopted = await second.adopt(params(value), {
      allowedSourceRoots: [value.sourceRoot]
    })
    assert.notEqual(adopted.sessionId, oldSessionId)
    assert.equal(
      existsSync(kernelSessionMigrationPaths(value.agentDir, oldSessionId).directory),
      false
    )
    assert.deepEqual(
      (await second.list()).sessions.map((entry) => entry.sessionId),
      [adopted.sessionId]
    )
  } finally {
    await first.close(oldSessionId)
    for (const entry of (await second.list()).sessions) await second.close(entry.sessionId)
    rmSync(value.root, { recursive: true, force: true })
  }
})

test('racing adopts have one writer and converge on one deterministic session', async () => {
  const value = await fixture('race')
  const left = repository(value.agentDir, 'adopt-left')
  const right = repository(value.agentDir, 'adopt-right')
  try {
    const results = await Promise.allSettled([
      left.adopt(params(value), { allowedSourceRoots: [value.sourceRoot] }),
      right.adopt(params(value), { allowedSourceRoots: [value.sourceRoot] })
    ])
    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    assert.ok(fulfilled.length >= 1)
    assert.equal(new Set(fulfilled.map((result) => result.value.sessionId)).size, 1)
    for (const rejected of results.filter((result) => result.status === 'rejected')) {
      assert.ok(rejected.reason instanceof SessionWriterBusyError)
    }

    const sessionId = fulfilled[0]!.value.sessionId
    const waiting = results[0]?.status === 'rejected' ? left : right
    const retried = await waiting.adopt(params(value), {
      allowedSourceRoots: [value.sourceRoot]
    })
    assert.equal(retried.sessionId, sessionId)
    assert.equal((await waiting.list()).sessions.length, 1)
  } finally {
    const sessionId = adoptedSessionId('phi-session-1', sha256(value.source))
    await left.close(sessionId)
    await right.close(sessionId)
    rmSync(value.root, { recursive: true, force: true })
  }
})

test('non-journal regular files fail closed before a migration directory is created', async () => {
  const value = await fixture('bad-header')
  const repo = repository(value.agentDir, 'bad-header')
  writeFileSync(value.source, '{"not":"a session"}\n')
  try {
    await assert.rejects(
      repo.adopt(params(value), { allowedSourceRoots: [value.sourceRoot] }),
      /not an OMP journal/i
    )
    assert.deepEqual(await repo.list(), { sessions: [] })
  } finally {
    rmSync(value.root, { recursive: true, force: true })
  }
})
