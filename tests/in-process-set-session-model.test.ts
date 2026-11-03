import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

const execFileAsync = promisify(execFile)
const testFile = fileURLToPath(import.meta.url)
const MARKER = 'phi-set-session-model:ok'

const TUNNELLED = {
  provider: 'cursor',
  id: 'cursor-grok-4.6-fast',
  api: 'cursor-agent',
  baseUrl: 'http://127.0.0.1:41234',
  input: ['text']
}

/** The in-process runtime imports Bun-only modules, so the scenario runs in a Bun child. */
async function runScenario(): Promise<void> {
  const { setSessionModel } = await import('../src/main/agent/engine/in-process/session-runtime')
  const { sessions } = await import('../src/main/agent/engine/in-process/state')
  type Entry = Parameters<typeof sessions.set>[1]
  const agentDir = process.env.PI_CODING_AGENT_DIR!
  const applied: unknown[] = []
  const session = {
    sessionFile: undefined,
    messages: [],
    model: undefined as unknown,
    thinkingLevel: 'high',
    sessionManager: { getCwd: () => '/remote' },
    async setModel(model: unknown) {
      applied.push(model)
      session.model = model
    }
  }
  sessions.set('kernel-session', {
    result: { session },
    agentDir,
    context: {
      agentDir,
      modelRegistry: {
        find: (provider: string, id: string) =>
          provider === TUNNELLED.provider && id === TUNNELLED.id ? TUNNELLED : undefined
      }
    }
  } as unknown as Entry)
  await setSessionModel({
    sessionId: 'kernel-session',
    agentDir,
    model: { provider: TUNNELLED.provider, id: TUNNELLED.id }
  })
  assert.deepEqual(applied, [TUNNELLED])
  console.log(MARKER)
}

if (process.env.PHI_SET_SESSION_MODEL_SCENARIO === '1') {
  await runScenario()
  process.exit(0)
}

test('setSessionModel resolves Cursor through the session registry, not the desktop bridge', async () => {
  // A remote kernel's registry points Cursor at the SSH tunnel. A fresh registry would ask the
  // host for its loopback bridge, an address the server cannot reach.
  const home = await mkdtemp(join(tmpdir(), 'phi-set-model-'))
  try {
    const result = await execFileAsync('bun', [testFile], {
      cwd: home,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        PI_CODING_AGENT_DIR: home,
        PHI_SET_SESSION_MODEL_SCENARIO: '1'
      },
      timeout: 60_000,
      maxBuffer: 1024 * 1024
    })
    assert.match(result.stdout, new RegExp(MARKER))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
