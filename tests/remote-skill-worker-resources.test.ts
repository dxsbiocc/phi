import assert from 'node:assert/strict'
import test from 'node:test'

import {
  mergeRemoteProjectSkills,
  remoteProjectSkillsValue
} from '../src/main/agent/omp/remote-project-skills'

test('worker accepts only pinned trusted remote Skill metadata and gives it project precedence', () => {
  const remote = remoteProjectSkillsValue([
    {
      name: 'server-demo',
      description: 'Server project workflow.',
      filePath: 'ssh://cluster/srv/project/.phi/skills/server-demo/SKILL.md',
      disableModelInvocation: true,
      remoteProject: {
        relativePath: '.phi/skills/server-demo/SKILL.md',
        contentHash: 'a'.repeat(64)
      }
    },
    {
      name: 'unsafe',
      description: 'Traversal',
      filePath: 'ssh://cluster/srv/project/unsafe/SKILL.md',
      remoteProject: { relativePath: '../unsafe/SKILL.md', contentHash: 'b'.repeat(64) }
    }
  ])

  assert.deepEqual(remote, [
    {
      name: 'server-demo',
      description: 'Server project workflow.',
      filePath: 'ssh://cluster/srv/project/.phi/skills/server-demo/SKILL.md',
      baseDir: 'ssh://cluster/srv/project/.phi/skills/server-demo',
      source: 'server-project',
      hide: true
    }
  ])
  assert.deepEqual(
    mergeRemoteProjectSkills(
      [
        {
          name: 'server-demo',
          description: 'Global shadow',
          filePath: '/global/server-demo/SKILL.md',
          baseDir: '/global/server-demo',
          source: 'global'
        }
      ],
      [],
      remote
    ),
    remote
  )
})
