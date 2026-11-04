import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { LocalRegistry } from '../src/main/agent/packages/installer-types'
import { installPackages, planInstall } from '../src/main/agent/packages/installer'
import {
  listKnownRegistries,
  loadKnownRegistryIndexes
} from '../src/main/agent/packages/registries'
import { OFFICIAL_REGISTRY_ID } from '../src/main/agent/packages/official-registry'
import { createMemberKeys, createTeamKeys } from '../src/main/agent/team-pack/keys'
import { publishTeamRelease } from '../src/main/agent/team-pack/publish'
import { TeamSourceService } from '../src/main/agent/team-pack/team-source'
import { installedSkillPath, SKILL_ID, TEAM_ID, writeSkillRegistry } from './team-pack-fixtures'

test('two members install the same release and a removed member keeps the old installation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-team-member-install-'))
  try {
    const storeDir = join(root, 'store')
    const registryDir = join(root, 'registry')
    const firstAgentDir = join(root, 'member-a')
    const secondAgentDir = join(root, 'member-b')
    const team = createTeamKeys({ teamId: TEAM_ID, name: 'Alpha Team' })
    const firstMember = await createMemberKeys()
    const secondMember = await createMemberKeys()

    writeSkillRegistry(registryDir, '1.0.0')
    await publishTeamRelease({
      storeDir,
      team,
      members: [firstMember.recipient, secondMember.recipient],
      registryDir
    })

    const firstService = sourceService(firstAgentDir, firstMember.identity, 'source-a')
    const secondService = sourceService(secondAgentDir, secondMember.identity, 'source-b')
    const location = { kind: 'directory' as const, path: storeDir }
    const [firstSource, secondSource] = await Promise.all([
      firstService.addSource({ teamKeyId: team.keyId, location }),
      secondService.addSource({ teamKeyId: team.keyId, location })
    ])
    const [firstPull, secondPull] = await Promise.all([
      firstService.pullSource(firstSource.id),
      secondService.pullSource(secondSource.id)
    ])
    assert.equal(firstPull.status.lastSuccessfulRelease, 1)
    assert.equal(secondPull.status.lastSuccessfulRelease, 1)

    await Promise.all([
      installTeamSkill(firstAgentDir, firstSource.id, '1.0.0'),
      installTeamSkill(secondAgentDir, secondSource.id, '1.0.0')
    ])
    assert.equal(existsSync(installedSkillPath(firstAgentDir, '1.0.0')), true)
    assert.equal(existsSync(installedSkillPath(secondAgentDir, '1.0.0')), true)

    writeSkillRegistry(registryDir, '2.0.0')
    await publishTeamRelease({
      storeDir,
      team,
      members: [secondMember.recipient],
      registryDir
    })

    await assert.rejects(firstService.pullSource(firstSource.id), { code: 'NOT_A_MEMBER' })
    const secondUpdate = await secondService.pullSource(secondSource.id)
    assert.equal(secondUpdate.status.lastSuccessfulRelease, 2)
    await installTeamSkill(secondAgentDir, secondSource.id, '2.0.0')

    assert.equal(existsSync(installedSkillPath(firstAgentDir, '1.0.0')), true)
    assert.equal(existsSync(installedSkillPath(secondAgentDir, '1.0.0')), false)
    assert.equal(existsSync(installedSkillPath(secondAgentDir, '2.0.0')), true)

    const firstListed = await listKnownRegistries(registryOptions(firstAgentDir))
    const cached = firstListed.registries.find((registry) => registry.id === firstSource.id)
    assert.equal(cached?.status, 'cached')
    assert.equal(cached?.version, 1)
    assert.match(cached?.notice ?? '', /NOT_A_MEMBER/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function sourceService(agentDir: string, identity: string, id: string): TeamSourceService {
  return new TeamSourceService({
    agentDir,
    getMemberIdentity: async () => identity,
    createId: () => id,
    now: () => new Date('2026-11-04T08:00:00.000Z')
  })
}

async function installTeamSkill(
  agentDir: string,
  sourceId: string,
  version: string
): Promise<void> {
  const loaded = await loadKnownRegistryIndexes(registryOptions(agentDir))
  const registry = loaded.registries.find((entry) => entry.id === sourceId)
  assert.ok(registry)
  assert.equal(registry.source?.kind, 'team')
  await installPackages(
    planInstall(registry, { type: 'skill', id: SKILL_ID, version }, { agentDir }),
    { agentDir }
  )
}

function registryOptions(agentDir: string): {
  agentDir: string
  loadOfficialRegistry: () => Promise<LocalRegistry>
} {
  return {
    agentDir,
    loadOfficialRegistry: async () => ({
      id: OFFICIAL_REGISTRY_ID,
      dir: join(agentDir, 'official'),
      trust: 'official',
      schemaVersion: 1,
      generatedAt: '2026-11-04T00:00:00.000Z',
      packages: [],
      status: 'ready'
    })
  }
}
