import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import test from 'node:test'

test(
  'real OMP SDK registers verified remote A and file-backed B tools',
  { timeout: 30_000 },
  () => {
    const result = spawnSync(
      'bun',
      [join(process.cwd(), 'tests', 'helpers', 'remoteParityToolSmoke.ts')],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 1024 * 1024
      }
    )
    assert.equal(result.status, 0, result.stderr)
    const output = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as {
      registered?: string[]
      requests?: number
    }
    assert.deepEqual(output.registered, [
      'web_search',
      'browser',
      'palette_suggest',
      'ask_user_question',
      'present_files',
      'download_file'
    ])
    assert.equal(output.requests, 4)
  }
)
