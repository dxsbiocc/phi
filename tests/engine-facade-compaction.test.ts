import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveBunExecutable } from '../src/main/agent/engine/bun-executable'

for (const mode of [
  'manual',
  'after-aborted',
  'automatic',
  'busy',
  'approval',
  'lookup-abort',
  'lookup-binding',
  'manual-lookup-abort',
  'manual-lookup-binding',
  'cancel',
  'lost-outcome',
  'settings',
  'settings-recovery',
  'defaults-disabled',
  'defaults-empty',
  'defaults-native',
  'defaults-fixed',
  'model-thresholds',
  'model-thresholds-startup'
])
  test(`actual Phi compaction control: ${mode}`, { timeout: 120000 }, async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-facade-regression-compaction-')))
    for (const name of ['home', 'agent', 'tmp']) await mkdir(join(root, name), { mode: 0o700 })
    const child = spawn(
      process.execPath,
      [
        '--import',
        './scripts/test-loader.mjs',
        mode === 'model-thresholds-startup'
          ? './tests/helpers/facadeCompactionUnsupportedPolicyOracle.ts'
          : './tests/helpers/facadeCompactionOracle.ts'
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
          PHI_FACADE_COMPACTION_MODE: mode,
          PHI_TEST_REAL_BUN: resolveBunExecutable(),
          PHI_OMP_WORKER_PATH: join(process.cwd(), 'src/main/agent/engine/in-process/main.ts')
        },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    t.signal.addEventListener(
      'abort',
      () => {
        t.diagnostic(output.trim())
        child.kill()
      },
      { once: true }
    )
    let output = ''
    child.stdout.on('data', (chunk) => {
      output = (output + chunk.toString()).slice(-32768)
    })
    child.stderr.on('data', (chunk) => {
      output = (output + chunk.toString()).slice(-32768)
    })
    try {
      const exit = await new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', resolve)
      })
      assert.equal(exit, 0, output)
      t.diagnostic(output.trim())
    } finally {
      child.kill()
      await rm(root, { recursive: true, force: true })
    }
  })
