import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import test from 'node:test'

const bunAvailable = spawnSync('bun', ['--version'], { encoding: 'utf8' }).status === 0

test(
  'real OMP SDK routes six same-name tools to Phi and restricts the remote Wrapper expert',
  {
    skip: !bunAvailable
  },
  () => {
    const result = spawnSync(
      'bun',
      [join(process.cwd(), 'tests', 'helpers', 'remoteOmpToolSmoke.ts')],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 1024 * 1024
      }
    )
    assert.equal(result.status, 0, result.stderr)
    const lines = result.stdout.trim().split('\n')
    const output = JSON.parse(lines.at(-1) ?? '{}') as {
      verified?: string[]
      read?: string
      main?: string
      specialistRead?: string
      specialist?: string[]
    }
    assert.deepEqual(output.verified, ['read', 'write', 'edit', 'bash', 'glob', 'grep'])
    assert.equal(output.read, 'remote-only')
    assert.equal(output.main, 'main-updated')
    assert.equal(output.specialistRead, 'specialist-updated')
    assert.deepEqual(output.specialist, [
      'read',
      'write',
      'edit',
      'bash',
      'glob',
      'grep',
      'wrapper_search',
      'wrapper_inspect',
      'wrapper_run',
      'wrapper_status',
      'wrapper_wait',
      'wrapper_cancel'
    ])
  }
)
