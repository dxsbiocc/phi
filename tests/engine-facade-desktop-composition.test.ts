import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveBunExecutable } from '../src/main/agent/engine/bun-executable'

for (const mode of [
  'library-flow',
  'library-denied',
  'library-pending-stop',
  'library-lookup-stop',
  'library-lookup-rebind',
  'search-flow',
  'search-stop',
  'interaction-flow',
  'interaction-stop',
  'skill-flow',
  'skill-denied',
  'skill-pending-stop',
  'skill-revoked',
  'environment-denied',
  'environment-pending-stop',
  'mcp-flow',
  'mcp-denied',
  'mcp-stop',
  'browser-flow',
  'browser-denied',
  'browser-stop',
  'download-flow',
  'download-denied',
  'download-stop',
  'notebook-execution-flow',
  'notebook-execution-denied',
  'notebook-execution-stop',
  'notebook-execution-unconfirmed'
])
  test(`actual application desktop services: ${mode}`, { timeout: 120000 }, async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-facade-regression-desktop-')))
    for (const dir of ['home', 'agent', 'tmp']) await mkdir(join(root, dir), { mode: 0o700 })
    const child = spawn(
      process.execPath,
      ['--import', './scripts/test-loader.mjs', './tests/helpers/facadeDesktopOracle.ts'],
      {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH,
          HOME: join(root, 'home'),
          PI_CODING_AGENT_DIR: join(root, 'agent'),
          TMPDIR: join(root, 'tmp'),
          XDG_DATA_HOME: join(root, 'home/.local/share'),
          XDG_CACHE_HOME: join(root, 'home/.cache'),
          PHI_FACADE_DESKTOP_MODE: mode,
          PHI_TEST_REAL_BUN: resolveBunExecutable(),
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
