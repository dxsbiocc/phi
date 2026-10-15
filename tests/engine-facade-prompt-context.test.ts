import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveBunExecutable } from '../src/main/agent/engine/bun-executable'
for (const mode of ['default', 'combined', 'stop', 'rebind', 'late-rebind', 'untrusted', 'memory'])
  test(`actual Phi prompt policy: ${mode}`, { timeout: 120000 }, async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-facade-regression-prompt-')))
    for (const name of ['home', 'agent', 'tmp']) await mkdir(join(root, name), { mode: 0o700 })
    let output = ''
    const child = spawn(
      process.execPath,
      [
        '--import',
        './scripts/test-loader.mjs',
        mode === 'memory'
          ? './tests/helpers/facadeProjectMemoryOracle.ts'
          : './tests/helpers/facadePromptContextOracle.ts'
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
          PHI_PROMPT_MODE: mode,
          PHI_TEST_REAL_BUN: resolveBunExecutable(),
          PHI_OMP_WORKER_PATH: join(process.cwd(), 'src/main/agent/engine/in-process/main.ts')
        },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    child.stdout.on('data', (chunk) => {
      output = (output + chunk.toString()).slice(-32768)
    })
    child.stderr.on('data', (chunk) => {
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
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', resolve)
      })
      assert.equal(code, 0, output)
      t.diagnostic(output.trim())
    } finally {
      child.kill()
      await rm(root, { recursive: true, force: true })
    }
  })
