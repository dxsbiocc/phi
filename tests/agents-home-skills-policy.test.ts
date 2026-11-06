import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('Phi hard-disables foreign home skill discovery and wires the OMP overrides', () => {
  const settings = readFileSync('src/main/agent/engine/in-process/settings.ts', 'utf8')
  assert.match(settings, /export function applyForeignHomeSkillsPolicy/)
  assert.match(settings, /cfgSkillsEnableAgentsUser\.override\(settings, false\)/)
  assert.match(settings, /cfgSkillsEnableClaudeUser\.override\(settings, false\)/)
  assert.match(settings, /cfgSkillsEnableCodexUser\.override\(settings, false\)/)
  assert.doesNotMatch(settings, /enableAgentsHomeSkills/)

  for (const path of [
    'src/main/agent/engine/in-process/resources.ts',
    'src/main/agent/engine/in-process/session-creation.ts',
    'src/main/agent/engine/in-process/subagents.ts'
  ]) {
    assert.match(
      readFileSync(path, 'utf8'),
      /applyForeignHomeSkillsPolicy/,
      `${path} must apply the foreign home skills policy`
    )
  }
  assert.match(
    readFileSync('src/main/agent/engine/in-process/tool-registry.ts', 'utf8'),
    /settingsManager: settings/
  )
  assert.doesNotMatch(
    readFileSync('src/shared/appSettingsTypes.ts', 'utf8'),
    /enableAgentsHomeSkills|DEFAULT_ENABLE_AGENTS_HOME_SKILLS/
  )
})
