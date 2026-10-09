import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { findBunExecutable } from '../src/main/agent/omp/bun-executable'

const bun = findBunExecutable()
test(
  'owned stdio scopes isolate concurrent transports, leave unowned APIs unchanged, and prevent late spawn',
  { skip: !bun, timeout: 20_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'phi-stdio-scope-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const fixture = join(process.cwd(), 'tests/helpers/ownedStdioScopeFixture.ts')
    const server = join(process.cwd(), 'tests/helpers/fixtureMcpServer.mjs')
    const result = await promisify(execFile)(bun!, [fixture, root, process.execPath, server], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: root },
      timeout: 15_000
    })
    assert.deepEqual(JSON.parse(result.stdout), {
      isolated: true,
      concurrentCloseAwaited: true,
      lateSpawnPrevented: true
    })
  }
)
