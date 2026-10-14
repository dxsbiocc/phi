import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { resolveBunExecutable } from '../src/main/agent/engine/bun-executable'

test(
  'production native adapter parser/repair/scope/cancellation/concurrency contracts on pinned Bun',
  { timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'phi-native-unit-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    for (const name of ['home', 'agent', 'project']) await mkdir(join(root, name), { mode: 0o700 })
    const result = await promisify(execFile)(
      resolveBunExecutable(),
      [fileURLToPath(new URL('./helpers/rpcNativeStreamUnit.ts', import.meta.url))],
      {
        cwd: join(root, 'project'),
        env: {
          PATH: process.env.PATH,
          HOME: join(root, 'home'),
          PI_CODING_AGENT_DIR: join(root, 'agent'),
          TMPDIR: root
        },
        timeout: 25000,
        maxBuffer: 32768
      }
    )
    assert.equal(result.stderr, '')
    const report = JSON.parse(result.stdout) as { passed: number; names: string[] }
    assert.ok(report.passed >= 35, result.stdout)
    assert.equal(report.passed, report.names.length)
    t.diagnostic(`${report.passed} independent adapter contract scenarios passed`)
  }
)
