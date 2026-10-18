import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import { PINNED_OMP_VERSION } from '../src/main/agent/engine/omp-version'
import { RPC_BOOTSTRAP_OMP_VERSION } from '../src/main/agent/engine/phi-extension/lib/rpc-config'
import { REMOTE_OMP_MANIFEST } from '../src/main/agent/engine/rpc/runtime-deployment/manifest'
import { REMOTE_OMP_VERSION } from '../src/main/agent/session/runtime-reference'

function readJson(path: string): { version?: string; dependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(resolve(process.cwd(), path), 'utf8'))
}

test('every OMP version site agrees with the single pinned constant', () => {
  const pkg = readJson('package.json')
  assert.equal(pkg.dependencies?.['@oh-my-pi/pi-coding-agent'], PINNED_OMP_VERSION)
  assert.equal(pkg.dependencies?.['@oh-my-pi/pi-natives'], PINNED_OMP_VERSION)
  assert.equal(
    readJson('node_modules/@oh-my-pi/pi-coding-agent/package.json').version,
    PINNED_OMP_VERSION,
    'installed SDK differs from the pin; run bun install'
  )
  // The remote extension bundle must stay self-contained, so it keeps its own literal.
  assert.equal(RPC_BOOTSTRAP_OMP_VERSION, PINNED_OMP_VERSION)
  assert.equal(REMOTE_OMP_VERSION, PINNED_OMP_VERSION)
  assert.equal(REMOTE_OMP_MANIFEST.version, PINNED_OMP_VERSION)
})

test('runtime manifest release URLs point at the pinned release', () => {
  for (const asset of Object.values(REMOTE_OMP_MANIFEST.assets)) {
    assert.ok(asset, 'manifest asset missing')
    assert.ok(
      asset.url.includes(`/download/v${PINNED_OMP_VERSION}/`),
      `${asset.url} is not release v${PINNED_OMP_VERSION}`
    )
  }
})
