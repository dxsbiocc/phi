import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { RemoteEnvironmentService } from '../src/main/agent/remote-runtime/environment-service'
import { RemoteSkillService } from '../src/main/agent/remote-runtime/skill-service'
import { createRemoteRuntimeFixture, writeTestSkill } from './helpers/remoteRuntimeFixture'

test('remote skills reject package-local environments with an actionable alternative', async () => {
  const fixture = createRemoteRuntimeFixture()
  try {
    const skill = writeTestSkill(fixture)
    const markdown = readFileSync(skill.filePath, 'utf8').replace(
      'phi:python@1',
      './environment.yml'
    )
    writeFileSync(skill.filePath, markdown)
    writeLocalEnvironment(skill.dir)
    const environments = new RemoteEnvironmentService({
      micromambaVersion: 'test',
      openWorkspace: async () => fixture.workspace,
      confirm: async () => true
    })
    const service = new RemoteSkillService({
      openWorkspace: async () => fixture.workspace,
      environments,
      listSkills: async () => [{ ...skill, insidePlugin: false }]
    })

    const listed = await service.scriptTools()
    assert.deepEqual(listed.tools, [])
    assert.match(listed.problems.join('\n'), /phi:.*预构建.*没有回退/u)
    await assert.rejects(
      service.run({
        requestId: 'local-environment-skill',
        runtimeSessionId: 'runtime-1',
        skill: skill.name,
        script: 'run.sh',
        args: []
      }),
      /phi:.*预构建.*没有回退/u
    )
  } finally {
    fixture.cleanup()
  }
})

function writeLocalEnvironment(skillDir: string): void {
  writeFileSync(
    join(skillDir, 'environment.yml'),
    'name: local-skill\nchannels: [conda-forge]\ndependencies: [python=3.12]\n'
  )
  const locks = join(skillDir, 'locks')
  mkdirSync(locks)
  for (const platform of ['darwin-arm64', 'darwin-x64', 'linux-x64']) {
    writeFileSync(join(locks, `${platform}.txt`), '')
  }
}
