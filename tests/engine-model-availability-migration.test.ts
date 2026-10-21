import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
  getModelAvailabilityPath,
  isModelEnabled,
  readModelAvailability,
  writeModelAvailabilityChange
} from '../src/main/agent/model-availability'
import { createInProcessFixture } from './engine-contract/in-process-factory'

test(
  'Phi model switches survive actual SDK first-session settings migration and worker restart',
  { timeout: 30000 },
  async (t) => {
    const f = await createInProcessFixture()
    t.after(() => f.close())
    // Reproduce OMP's first-profile path instead of the fixture's pre-created YAML shortcut.
    rmSync(join(f.agentDir, 'config.yml'))
    writeFileSync(
      join(f.agentDir, 'settings.json'),
      JSON.stringify({ uiLanguage: 'zh-CN', custom: 'preserve-in-backup' })
    )
    writeModelAvailabilityChange({ providerId: 'typesafe', enabled: false }, f.agentDir)
    writeModelAvailabilityChange(
      { providerId: 'typesafe', modelId: 'jev-test', enabled: false },
      f.agentDir
    )
    const policyBefore = readFileSync(getModelAvailabilityPath(f.agentDir), 'utf8')
    const create = (sessionId: string): ReturnType<typeof f.engine.sessions.create> =>
      f.engine.sessions.create({
        sessionId,
        agentDir: f.agentDir,
        cwd: f.cwd,
        model: f.model,
        sessionManager: { kind: 'memory', cwd: f.cwd },
        enableToolApproval: false,
        noTools: 'all',
        resourceOptions: {
          noExtensions: true,
          noSkills: true,
          noContextFiles: true,
          noPromptTemplates: true,
          noThemes: true
        },
        autoCompaction: { enabled: false }
      })
    await create('first-profile')
    assert.equal(existsSync(join(f.agentDir, 'settings.json')), false)
    assert.equal(existsSync(join(f.agentDir, 'settings.json.bak')), true)
    assert.equal(existsSync(join(f.agentDir, 'config.yml')), true)
    assert.equal(readFileSync(getModelAvailabilityPath(f.agentDir), 'utf8'), policyBefore)
    assert.equal(isModelEnabled(readModelAvailability(f.agentDir), 'typesafe', 'jev-test'), false)
    await f.engine.stop()
    await create('restarted-profile')
    assert.equal(readFileSync(getModelAvailabilityPath(f.agentDir), 'utf8'), policyBefore)
    const policy = readModelAvailability(f.agentDir)
    assert.deepEqual(policy.disabledModels, [{ providerId: 'typesafe', modelId: 'jev-test' }])
    assert.equal(isModelEnabled(policy, 'typesafe'), false)
    assert.equal(f.provider.requests.length, 0)
  }
)
