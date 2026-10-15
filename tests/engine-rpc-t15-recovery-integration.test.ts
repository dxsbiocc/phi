import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveBunExecutable } from '../src/main/agent/engine/bun-executable'
import { t15AttachedReadback } from './helpers/t15RecoveryObservation'
import {
  remoteOmpDurableSessionKey,
  type RemoteOmpRuntimeRef
} from '../src/main/agent/session/runtime-reference'

test('T15 observation never confuses bootstrap B with restored original-journal B', () => {
  const scope = {
    hostProfileId: 'host',
    bindingHash: 'a'.repeat(64),
    projectId: 'project',
    projectRoot: '/server/project',
    runtimeRoot: '/server/runtime'
  }
  const reference: RemoteOmpRuntimeRef = {
    ...scope,
    kind: 'remote-omp',
    version: 1,
    ompVersion: '18.10.3',
    ompSessionId: 'original',
    journalBasename: 'original.jsonl',
    durableSessionKey: remoteOmpDurableSessionKey(scope, 'phi')
  }
  const model = { provider: 'fixture', id: 'model-b' }
  const journal = `${scope.runtimeRoot}/omp-sessions/${reference.durableSessionKey}/journals/original.jsonl`
  assert.equal(
    t15AttachedReadback(
      { sessionId: 'bootstrap', sessionFile: '/bootstrap.jsonl', model },
      reference,
      model
    ),
    false
  )
  assert.equal(
    t15AttachedReadback(
      { sessionId: 'original', sessionFile: '/peer.jsonl', model },
      reference,
      model
    ),
    false
  )
  assert.equal(
    t15AttachedReadback({ sessionId: 'original', sessionFile: journal, model }, reference, model),
    true
  )
})

test(
  'actual T15 model replacement proves old A, rejects a vanished B, and accepts the next explicit prompt',
  { timeout: 120000 },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-facade-regression-t15-')))
    let child: ReturnType<typeof spawn> | undefined
    let closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined
    let output = ''
    const abort = (): void => {
      child?.kill()
    }
    try {
      for (const directory of ['home', 'agent', 'tmp'])
        await mkdir(join(root, directory), { mode: 0o700 })
      child = spawn(
        process.execPath,
        ['--import', './scripts/test-loader.mjs', './tests/helpers/t15RecoveryOracle.ts'],
        {
          cwd: process.cwd(),
          env: {
            PATH: process.env.PATH,
            HOME: join(root, 'home'),
            PI_CODING_AGENT_DIR: join(root, 'agent'),
            TMPDIR: join(root, 'tmp'),
            XDG_DATA_HOME: join(root, 'home/.local/share'),
            XDG_CACHE_HOME: join(root, 'home/.cache'),
            PHI_TEST_REAL_BUN: resolveBunExecutable(),
            PHI_OMP_WORKER_PATH: join(process.cwd(), 'src/main/agent/engine/in-process/main.ts')
          },
          stdio: ['ignore', 'pipe', 'pipe']
        }
      )
      closed = new Promise((resolve, reject) => {
        child!.once('error', reject)
        child!.once('close', (code, signal) => resolve({ code, signal }))
      })
      for (const stream of [child.stdout, child.stderr])
        stream?.on('data', (chunk) => {
          output = (output + chunk.toString()).slice(-32768)
        })
      t.signal.addEventListener('abort', abort, { once: true })
      if (t.signal.aborted) abort()
      const result = await closed
      assert.equal(result.code, 0, output)
      assert.equal(result.signal, null, output)
      assert.match(output, /"vanishedModelRejected":true/)
      assert.match(output, /"savedProofModel":"model-a"/)
      assert.match(output, /"recoveredModel":"model-b"/)
      assert.match(output, /"providerRequests":2/)
      t.diagnostic(output.trim())
    } finally {
      t.signal.removeEventListener('abort', abort)
      if (child && child.exitCode === null && child.signalCode === null) child.kill()
      await closed?.catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  }
)
