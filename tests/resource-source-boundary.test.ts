import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { installBundledPlugins } from '../src/main/agent/plugins/bundled-install'
import { ensureBundledWrappersInstalled } from '../src/main/agent/wrappers/catalog'
import { packageContentRoot } from './helpers/packageContent'

test('legacy source migration never implicitly reads resources or changes the agent directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-resource-source-boundary-'))
  const agentDir = join(root, 'agent')
  try {
    await assert.rejects(ensureBundledWrappersInstalled(agentDir), /explicit sourceRoot/)
    await assert.rejects(installBundledPlugins({ agentDir }), /explicit bundledDir/)
    assert.equal(existsSync(agentDir), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('content integration reports a missing selected source instead of falling back to Phi', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-missing-package-content-'))
  const previous = process.env.PHI_PACKAGES_ROOT
  try {
    process.env.PHI_PACKAGES_ROOT = join(root, 'absent')
    assert.throws(packageContentRoot, /Phi Packages checkout is missing.*test:packages/)
  } finally {
    if (previous === undefined) delete process.env.PHI_PACKAGES_ROOT
    else process.env.PHI_PACKAGES_ROOT = previous
    rmSync(root, { recursive: true, force: true })
  }
})
