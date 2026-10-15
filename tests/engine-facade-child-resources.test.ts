import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveBunExecutable } from '../src/main/agent/engine/bun-executable'

test(
  'actual application trusted scientific child resources retain native effects, host blobs and independent model',
  { timeout: 120000 },
  async (t) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'phi-facade-regression-child-resources-'))
    )
    for (const directory of ['home', 'agent', 'tmp'])
      await mkdir(join(root, directory), { mode: 0o700 })
    const child = spawn(
      process.execPath,
      ['--import', './scripts/test-loader.mjs', './tests/helpers/facadeChildResourcesOracle.ts'],
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
    let output = ''
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (chunk) => {
        output = (output + chunk.toString()).slice(-32768)
      })
    t.signal.addEventListener(
      'abort',
      () => {
        t.diagnostic(output)
        child.kill()
      },
      { once: true }
    )
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
  }
)
