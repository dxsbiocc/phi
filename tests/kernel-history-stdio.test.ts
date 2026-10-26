import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test, { type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { JsonValue } from '../src/shared/kernel-protocol'
import { resolveBunExecutable } from '../src/main/agent/engine/bun-executable'
import {
  KernelClientError,
  spawnKernelStdio,
  type SpawnedKernelClient
} from '../src/main/agent/engine/kernel-client'

async function spawnKernel(
  t: TestContext,
  root: string,
  agentDir: string,
  adoptRoots?: string
): Promise<SpawnedKernelClient> {
  const spawned = spawnKernelStdio({
    cwd: resolve('.'),
    bunArgs: [
      '--preload',
      fileURLToPath(new URL('./engine-contract/network-guard.ts', import.meta.url))
    ],
    env: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: join(root, 'home'),
      TMPDIR: join(root, 'tmp'),
      PI_CODING_AGENT_DIR: agentDir,
      OMP_APP_NAME: 'Phi',
      ...(adoptRoots ? { PHI_KERNEL_ADOPT_ROOTS: adoptRoots } : {})
    },
    onDiagnostic: () => undefined
  })
  t.after(() => spawned.close())
  return spawned
}

test('session.adopt is offered only with trusted roots and adopts over stdio', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'phi-history-stdio-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const cwd = join(root, 'project')
  const sourceRoot = join(root, 'staging')
  const outsideRoot = join(root, 'outside')
  const agentDir = join(root, 'agent')
  for (const dir of [
    cwd,
    sourceRoot,
    outsideRoot,
    agentDir,
    join(root, 'home'),
    join(root, 'tmp')
  ]) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(
    join(agentDir, 'models.yml'),
    JSON.stringify({
      providers: {
        'phi-history': {
          baseUrl: 'http://127.0.0.1:9/v1',
          apiKey: 'fake-history-inline-key',
          api: 'openai-completions',
          models: [
            {
              id: 'history-model',
              name: 'History Fixture Model',
              reasoning: false,
              input: ['text'],
              contextWindow: 32_768,
              maxTokens: 256,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
            }
          ]
        }
      }
    })
  )
  writeFileSync(
    join(agentDir, 'config.yml'),
    JSON.stringify({ defaultProvider: 'phi-history', defaultModel: 'history-model' })
  )
  // OMP's SessionManager needs Bun built-ins, so the fixture journal is written by a Bun child.
  const writeJournal = async (path: string): Promise<void> => {
    const script = [
      "import { makeSessionManager } from './src/main/agent/engine/in-process/session-factory'",
      'const { FIXTURE_PATH: path, FIXTURE_CWD: cwd, FIXTURE_AGENT_DIR: agentDir } = process.env',
      "const manager = await makeSessionManager({ kind: 'persistent', path }, cwd, agentDir)",
      "manager.appendMessage({ role: 'user', content: 'historic turn', timestamp: Date.now() })",
      'await manager.close()'
    ].join('\n')
    execFileSync(resolveBunExecutable(), ['-e', script], {
      env: { ...process.env, FIXTURE_PATH: path, FIXTURE_CWD: cwd, FIXTURE_AGENT_DIR: agentDir },
      cwd: resolve('.'),
      stdio: ['ignore', 'ignore', 'inherit']
    })
  }
  const source = join(sourceRoot, 'journal.jsonl')
  const outside = join(outsideRoot, 'journal.jsonl')
  await writeJournal(source)
  await writeJournal(outside)
  const adoptParams = (path: string): JsonValue => ({
    source: { kind: 'omp-journal', path, cwd, origin: 'desktop-local', phiSessionId: 'phi-stdio' }
  })

  const without = await spawnKernel(t, root, agentDir)
  const plain = await without.client.hello()
  assert.equal(plain.capabilities.includes('session.adopt'), false)
  await assert.rejects(without.client.request('session.adopt', adoptParams(source)), (error) => {
    assert.ok(error instanceof KernelClientError)
    assert.equal(error.code, 'CAPABILITY_UNAVAILABLE')
    return true
  })
  await without.close()

  const trusted = await spawnKernel(t, root, agentDir, sourceRoot)
  const greeting = await trusted.client.hello()
  assert.ok(greeting.capabilities.includes('session.adopt'))
  await assert.rejects(trusted.client.request('session.adopt', adoptParams(outside)), (error) => {
    assert.ok(error instanceof KernelClientError)
    return true
  })
  const adopted = (await trusted.client.request('session.adopt', adoptParams(source))) as {
    sessionId: string
    migration: { state: string }
  }
  assert.equal(adopted.migration.state, 'complete')
  assert.deepEqual(await trusted.client.request('session.open', { sessionId: adopted.sessionId }), {
    sessionId: adopted.sessionId
  })
})
