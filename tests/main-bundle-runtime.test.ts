import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { inspectMainBundleRuntime } from '../scripts/check-main-bundle-runtime'

function fixture(files: Record<string, string>): { main: string; close(): void } {
  const root = mkdtempSync(join(tmpdir(), 'phi-main-runtime-check-'))
  const main = join(root, 'out', 'main')
  for (const [path, source] of Object.entries(files)) {
    const target = join(main, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, source)
  }
  return { main, close: () => rmSync(root, { recursive: true, force: true }) }
}

test('main bundle guard follows static and dynamic imports to Bun-only packages', () => {
  const output = fixture({
    'index.mjs': "import './safe.mjs'; void import('./lazy.mjs')",
    'safe.mjs': "import { join } from 'node:path'; export { join }",
    'lazy.mjs': "import '@oh-my-pi/pi-coding-agent'"
  })
  try {
    const report = inspectMainBundleRuntime(output.main, [])
    assert.deepEqual(report.reachedFiles, ['index.mjs', 'lazy.mjs', 'safe.mjs'])
    assert.deepEqual(report.violations, [
      {
        file: 'lazy.mjs',
        specifier: '@oh-my-pi/pi-coding-agent',
        reason: 'bun-only-import'
      }
    ])
  } finally {
    output.close()
  }
})

test('main bundle guard permits Bun-only packages only below explicit child entries', () => {
  const output = fixture({
    'index.mjs': "import './safe.mjs'",
    'safe.mjs': 'export const safe = true',
    'agent/worker.ts': "import './sdk.ts'",
    'agent/sdk.ts': "import '@oh-my-pi/pi-coding-agent'"
  })
  try {
    const report = inspectMainBundleRuntime(output.main, ['agent/worker.ts'])
    assert.deepEqual(report.violations, [])
    assert.deepEqual(report.allowedBunFiles, ['agent/sdk.ts', 'agent/worker.ts'])
  } finally {
    output.close()
  }
})

test('main bundle guard rejects unclassified detached Bun output', () => {
  const output = fixture({
    'index.mjs': 'export const safe = true',
    'agent/worker.ts': 'export const worker = true',
    'orphan.mjs': "import 'bun:sqlite'"
  })
  try {
    assert.deepEqual(inspectMainBundleRuntime(output.main, ['agent/worker.ts']).violations, [
      { file: 'orphan.mjs', specifier: 'bun:sqlite', reason: 'unclassified-bun-output' }
    ])
  } finally {
    output.close()
  }
})
