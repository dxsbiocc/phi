import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import {
  loadRemoteProjectSkillCatalog,
  readRemoteProjectSkillContent,
  readRemoteProjectSkillResource,
  trustRemoteProjectSkill
} from '../src/main/agent/content/remote-project-skill-service'
import { SshHost } from '../src/main/agent/workspace-host/ssh-host'
import { createRemoteRuntimeFixture } from './helpers/remoteRuntimeFixture'

test('remote project Skill stays view-only until its complete server snapshot is trusted', async () => {
  const fixture = createRemoteRuntimeFixture()
  const agentDir = join(fixture.root, 'agent')
  const skillDir = join(fixture.projectRoot, '.phi', 'skills', 'server-demo')
  mkdirSync(join(skillDir, 'references'), { recursive: true })
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    '---\nname: server-demo\ndescription: Server project workflow.\n---\nUse the server guide.\n'
  )
  writeFileSync(join(skillDir, 'references', 'guide.md'), '# Guide v1\n')
  const context = {
    sessionId: 'session-1',
    projectId: 'project-1',
    cwd: fixture.localAnchor,
    agentDir
  }
  const dependencies = {
    resolveBinding: () => ({
      sessionId: context.sessionId,
      projectId: context.projectId,
      hostAlias: 'fixture-host',
      remoteRoot: fixture.projectRoot,
      canonicalRoot: fixture.projectRoot,
      cacheKey: 'fixture',
      config: {
        remoteRoot: fixture.projectRoot,
        canonicalRoot: fixture.projectRoot,
        connect: fixture.connect
      }
    }),
    createHost: () =>
      new SshHost({
        remoteRoot: fixture.projectRoot,
        canonicalRoot: fixture.projectRoot,
        connect: fixture.connect
      })
  }
  try {
    const pending = await loadRemoteProjectSkillCatalog(context, dependencies)
    assert.equal(pending.summaries[0]?.trustState, 'pending')
    assert.equal(pending.sources.length, 0)
    assert.match(
      (await readRemoteProjectSkillContent(context, pending.summaries[0]!.filePath, dependencies))
        .content,
      /server guide/u
    )
    await assert.rejects(
      () => readRemoteProjectSkillResource(context, 'skill://server-demo', dependencies),
      /Unknown skill/u
    )

    await trustRemoteProjectSkill(
      context,
      {
        relativePath: pending.summaries[0]!.relativePath!,
        contentHash: pending.summaries[0]!.contentHash!
      },
      dependencies
    )
    const trusted = await loadRemoteProjectSkillCatalog(context, dependencies)
    assert.equal(trusted.summaries[0]?.trustState, 'trusted')
    assert.equal(trusted.sources.length, 1)
    assert.equal(
      (
        await readRemoteProjectSkillResource(
          context,
          'skill://server-demo/references/guide.md',
          dependencies
        )
      ).content,
      '# Guide v1\n'
    )

    writeFileSync(join(skillDir, 'references', 'guide.md'), '# Guide v2\n')
    const changed = await loadRemoteProjectSkillCatalog(context, dependencies)
    assert.equal(changed.summaries[0]?.trustState, 'changed')
    assert.equal(changed.sources.length, 0)
    await assert.rejects(
      () =>
        readRemoteProjectSkillResource(
          context,
          'skill://server-demo/references/guide.md',
          dependencies
        ),
      /Unknown skill/u
    )
  } finally {
    fixture.cleanup()
  }
})
