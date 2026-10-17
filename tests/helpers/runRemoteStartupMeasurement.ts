import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveBunExecutable } from '../../src/main/agent/engine/bun-executable'

const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-facade-regression-startup-')))
for (const directory of ['home', 'agent', 'tmp']) {
  await mkdir(join(root, directory), { mode: 0o700 })
}

let child: ReturnType<typeof spawn> | undefined
try {
  child = spawn(
    'node',
    ['--import', './scripts/test-loader.mjs', './tests/helpers/remoteStartupMeasurementOracle.ts'],
    {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH,
        HOME: join(root, 'home'),
        PI_CODING_AGENT_DIR: join(root, 'agent'),
        TMPDIR: join(root, 'tmp'),
        XDG_DATA_HOME: join(root, 'home/.local/share'),
        XDG_CACHE_HOME: join(root, 'home/.cache'),
        PHI_PACKAGES_ROOT: process.env.PHI_PACKAGES_ROOT,
        PHI_TEST_REAL_BUN: resolveBunExecutable(),
        PHI_OMP_WORKER_PATH: join(process.cwd(), 'src/main/agent/engine/in-process/main.ts'),
        PHI_REMOTE_STARTUP_COMMAND_DELAY_MS: process.env.PHI_REMOTE_STARTUP_COMMAND_DELAY_MS ?? '0'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString()
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })
  const exit = await new Promise<number | null>((resolve, reject) => {
    child!.once('error', reject)
    child!.once('exit', resolve)
  })
  assert.equal(exit, 0, stdout + stderr)
  process.stdout.write(stdout)
  process.stderr.write(stderr)
} finally {
  child?.kill()
  await rm(root, { recursive: true, force: true })
}
