import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { getEnablementSnapshot } from '../src/main/agent/enablement'
import { readPluginRegistry, writePluginRegistry } from '../src/main/agent/plugins/store'
import { migrateStartupPluginEnablement } from '../src/main/startup-plugin-enablement'

test('startup still migrates legacy plugin enablement if runtime root lookup fails', () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-startup-plugin-'))
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir
  try {
    writePluginRegistry(
      {
        version: 1,
        plugins: {
          sample: {
            version: '1.0.0',
            source: 'local',
            installedAt: '2026-10-23T00:00:00.000Z',
            enabled: true
          }
        }
      },
      agentDir
    )
    let rootLookups = 0
    assert.doesNotThrow(() =>
      migrateStartupPluginEnablement(agentDir, () => {
        rootLookups += 1
        throw new Error('runtime root unavailable')
      })
    )
    assert.equal(rootLookups, 1)
    assert.equal(readPluginRegistry(agentDir).plugins.sample.enabled, undefined)
    assert.equal(getEnablementSnapshot({ agentDir }).global['plugin:sample'], true)
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    rmSync(agentDir, { recursive: true, force: true })
  }
})
