import assert from 'node:assert/strict'
import test from 'node:test'

import { mainSkillEnablementOptions } from '../src/main/agent/omp/main-skill-enablement'

test('remote skill enablement omits the local SDK anchor project scope', () => {
  const anchor = '/local/private/remote-project-anchors/project-1'
  assert.deepEqual(mainSkillEnablementOptions(anchor, '/local/private/agent', '/remote/project'), {
    agentDir: '/local/private/agent'
  })
  assert.deepEqual(mainSkillEnablementOptions('/local/project', '/local/private/agent'), {
    agentDir: '/local/private/agent',
    projectDir: '/local/project'
  })
})
