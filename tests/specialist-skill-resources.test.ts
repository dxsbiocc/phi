import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { selectDeclaredSpecialistSkills } from '../src/main/agent/enablement'
import { specialistSkillFiles } from '../src/main/agent/engine/in-process/specialist-skills'
import { installPlugin } from '../src/main/agent/plugins/loader'
import { readDirectSkills } from '../src/main/agent/runtime/direct-skills'
import { writeRuntimePluginFixture } from './helpers/runtimePluginFixture'

test('a specialist sees the plugin skill its agent declares', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-specialist-skills-'))
  try {
    const agentDir = join(root, 'agent')
    const installed = installPlugin(writeRuntimePluginFixture(root), {
      agentDir,
      runtimeRoot: join(root, 'runtime')
    })
    assert.equal(installed.ok, true, JSON.stringify(installed.errors))

    // The kernel sends only policy booleans as a session's resourceOptions, so the
    // specialist must find skills installed after the conversation opened.
    const files = specialistSkillFiles({ noSkills: false }, agentDir, root)
    const declared = selectDeclaredSpecialistSkills(readDirectSkills(files), [
      'omics-visualization'
    ])
    assert.deepEqual(
      declared.map((skill) => skill.name),
      ['omics-visualization']
    )
    assert.match(declared[0]!.filePath, /packages\/plugin\/visualization\//)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
