import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveBunExecutable } from '../src/main/agent/engine/bun-executable'

for (const mode of [
  'app-notebook-approved',
  'app-notebook-denied',
  'app-notebook-pending-stop',
  'app-notebook-lookup-stop',
  'app-notebook-lookup-rebind',
  'app-selection-stale',
  'app-selection-abort',
  'app-approved',
  'app-pending-stop',
  'approved',
  'parallel-stop',
  'parallel-main-stop',
  'parallel-main-first',
  'parallel-child-first',
  'delayed-started',
  'two-child',
  'reentrant-close',
  'host-stop',
  'repeat-child',
  'storage-failure',
  'denied',
  'pending-stop',
  'bash-stop',
  'held-ack',
  'disabled',
  'profile',
  'missing-config',
  'wrong-config'
])
  test(
    `actual Phi engine foreground child composition: ${mode}`,
    { timeout: 120000 },
    async (t) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-facade-regression-child-')))
      for (const dir of ['home', 'agent', 'tmp']) await mkdir(join(root, dir), { mode: 0o700 })
      const child = spawn(
        process.execPath,
        ['--import', './scripts/test-loader.mjs', './tests/helpers/facadeChildOracle.ts'],
        {
          cwd: process.cwd(),
          env: {
            PATH: process.env.PATH,
            HOME: join(root, 'home'),
            PI_CODING_AGENT_DIR: join(root, 'agent'),
            TMPDIR: join(root, 'tmp'),
            XDG_DATA_HOME: join(root, 'home/.local/share'),
            XDG_CACHE_HOME: join(root, 'home/.cache'),
            PHI_FACADE_CHILD_MODE: mode,
            PHI_TEST_REAL_BUN: resolveBunExecutable(),
            PHI_OMP_WORKER_PATH: join(process.cwd(), 'src/main/agent/engine/in-process/main.ts')
          },
          stdio: ['ignore', 'pipe', 'pipe']
        }
      )
      t.signal.addEventListener('abort', () => child.kill(), { once: true })
      let output = '',
        error = ''
      child.stdout.on('data', (chunk) => {
        output = (output + chunk.toString()).slice(-32768)
      })
      child.stderr.on('data', (chunk) => {
        error = (error + chunk.toString()).slice(-32768)
      })
      try {
        const exit = await new Promise((resolve, reject) => {
          child.once('error', reject)
          child.once('exit', resolve)
        })
        assert.equal(exit, 0, output + error)
        if (mode.startsWith('parallel-')) t.diagnostic(output.trim())
      } finally {
        child.kill()
        await rm(root, { recursive: true, force: true })
      }
    }
  )
