import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveBunExecutable } from '../src/main/agent/engine/bun-executable'

for (const mode of [
  'usage',
  'rename',
  'busy',
  'approval',
  'late-policy',
  'cancel',
  'disconnect',
  'send-failure'
])
  test(`actual metadata contract: ${mode}`, { timeout: 120000 }, async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-facade-regression-metadata-')))
    for (const dir of ['home', 'agent', 'tmp']) await mkdir(join(root, dir), { mode: 0o700 })
    const child = spawn(
      process.execPath,
      ['--import', './scripts/test-loader.mjs', './tests/helpers/facadeMetadataOracle.ts'],
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
          PHI_OMP_WORKER_PATH: join(process.cwd(), 'src/main/agent/engine/in-process/main.ts'),
          PHI_FACADE_METADATA_MODE: mode
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
    } finally {
      child.kill()
      await rm(root, { recursive: true, force: true })
    }
  })
