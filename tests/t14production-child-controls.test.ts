import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { resolveBunExecutable } from '../src/main/agent/engine/bun-executable'

async function runControlCase(
  t: TestContext,
  mode: 'default' | 'later-main-denied'
): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-facade-regression-t14-controls-')))
  for (const directory of ['home', 'agent', 'tmp'])
    await mkdir(join(root, directory), { mode: 0o700 })
  const child = spawn(
    process.execPath,
    [
      '--import',
      './scripts/test-loader.mjs',
      './tests/helpers/t14ProductionChildControlsOracle.ts'
    ],
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
        PHI_T14_CONTROL_MODE: mode,
        PHI_OMP_WORKER_PATH: join(process.cwd(), 'src/main/agent/engine/in-process/main.ts')
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  t.signal.addEventListener('abort', () => child.kill(), { once: true })
  let output = ''
  child.stdout.on('data', (chunk) => {
    output = (output + chunk.toString()).slice(-32768)
  })
  child.stderr.on('data', (chunk) => {
    output = (output + chunk.toString()).slice(-32768)
  })
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', resolve)
    })
    assert.equal(code, 0, output)
    assert.ok(output.includes('PRODUCTION_CHILD_CONTROL_OK'), output)
    assert.ok(output.includes(`mode=${mode}`), output)
    t.diagnostic(output.trim())
  } finally {
    child.kill()
    await rm(root, { recursive: true, force: true })
  }
}

test(
  'actual production parallel/background private child control preserves its original parent and peer',
  { timeout: 120000 },
  (t) => runControlCase(t, 'default')
)

test(
  'an earlier background child continues after a later Main native write is denied',
  { timeout: 120000 },
  (t) => runControlCase(t, 'later-main-denied')
)
