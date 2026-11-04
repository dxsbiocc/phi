import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { stringify as stringifyYaml } from 'yaml'

import { createDeterministicTarGz } from '../src/main/agent/packages/archive'
import {
  installPackages,
  planInstall,
  type RegistryPackageEntry
} from '../src/main/agent/packages/installer'
import {
  listKnownRegistries,
  loadKnownRegistryIndexes
} from '../src/main/agent/packages/registries'
import { OFFICIAL_REGISTRY_ID } from '../src/main/agent/packages/official-registry'
import type { LocalRegistry } from '../src/main/agent/packages/installer-types'
import type { TeamSource } from '../src/main/agent/team-pack/team-source'

function sandbox(): { root: string; agentDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'phi-team-member-registry-'))
  return { root, agentDir: join(root, 'agent') }
}

function officialRegistry(agentDir: string): LocalRegistry {
  return {
    id: OFFICIAL_REGISTRY_ID,
    dir: join(agentDir, 'official'),
    trust: 'official',
    schemaVersion: 1,
    generatedAt: '2026-11-04T00:00:00.000Z',
    packages: [],
    status: 'ready'
  }
}

function teamSource(
  overrides: Partial<TeamSource> & Pick<TeamSource, 'id' | 'teamId' | 'teamName'>
): TeamSource {
  return {
    teamKeyId: 'a'.repeat(16),
    location: { kind: 'directory', path: '/unused/team-store' },
    addedAt: '2026-11-04T01:00:00.000Z',
    status: {
      lastSuccessfulRelease: 3,
      lastCheckedAt: '2026-11-04T02:00:00.000Z',
      lastErrorCode: null,
      withdrawnReleases: [],
      announcements: [],
      resources: { 'skill:team-skill': { sharing: 'forwardable' } },
      credentialConflicts: [],
      skippedProviders: []
    },
    ...overrides
  }
}

function teamRegistryDir(agentDir: string, source: TeamSource): string {
  assert.notEqual(source.status.lastSuccessfulRelease, null)
  return join(
    agentDir,
    'team-pack',
    'state',
    source.teamId,
    String(source.status.lastSuccessfulRelease),
    'registry'
  )
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function writeInstallableRegistry(registryDir: string): RegistryPackageEntry {
  mkdirSync(registryDir, { recursive: true })
  const skill = Buffer.from(
    '---\nname: team-skill\ndescription: Shared team skill.\n---\n\n# Team skill\n'
  )
  const manifest = Buffer.from(
    stringifyYaml({
      schemaVersion: 1,
      id: 'team-skill',
      type: 'skill',
      version: '1.0.0',
      title: 'Team skill',
      summary: 'Shared team skill.',
      files: 'files.json'
    })
  )
  const files = [
    { path: 'SKILL.md', size: skill.length, sha256: sha256(skill) },
    { path: 'phi-package.yaml', size: manifest.length, sha256: sha256(manifest) }
  ]
  const archive = createDeterministicTarGz([
    { path: 'SKILL.md', data: skill },
    { path: 'phi-package.yaml', data: manifest },
    { path: 'files.json', data: Buffer.from(`${JSON.stringify({ version: 1, files })}\n`) }
  ])
  const entry: RegistryPackageEntry = {
    id: 'team-skill',
    type: 'skill',
    version: '1.0.0',
    title: 'Team skill',
    summary: 'Shared team skill.',
    archive: 'skill-team-skill-1.0.0.tar.gz',
    sha256: sha256(archive),
    size: archive.length,
    dependsOn: []
  }
  writeFileSync(join(registryDir, entry.archive), archive)
  writeFileSync(
    join(registryDir, 'index.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-11-04T01:30:00.000Z',
      packages: [entry]
    })}\n`
  )
  return entry
}

test('lists a ready team source and installs its latest pulled registry with imported trust', async () => {
  const { root, agentDir } = sandbox()
  try {
    const source = teamSource({ id: 'team-source-alpha', teamId: 'alpha-team', teamName: 'Alpha' })
    const registryDir = teamRegistryDir(agentDir, source)
    writeInstallableRegistry(registryDir)
    const options = {
      agentDir,
      loadOfficialRegistry: async () => officialRegistry(agentDir),
      loadTeamSources: () => [source]
    }

    const listed = await listKnownRegistries(options)
    assert.deepEqual(listed.registries.at(-1), {
      id: source.id,
      kind: 'team',
      label: '来自 Alpha 团队',
      path: registryDir,
      addedAt: source.addedAt,
      removable: true,
      trust: 'imported',
      status: 'ready',
      version: 3,
      refreshedAt: '2026-11-04T02:00:00.000Z',
      packageCount: 1
    })

    const loaded = await loadKnownRegistryIndexes(options)
    const registry = loaded.registries.at(-1)
    assert(registry)
    assert.equal(registry.id, source.id)
    assert.equal(registry.dir, registryDir)
    assert.equal(registry.trust, 'imported')
    assert.deepEqual(registry.source, {
      kind: 'team',
      id: source.id,
      teamId: source.teamId,
      teamName: source.teamName,
      teamKeyId: source.teamKeyId,
      release: 3,
      resources: { 'skill:team-skill': { sharing: 'forwardable' } }
    })

    await installPackages(
      planInstall(registry, { type: 'skill', id: 'team-skill' }, { agentDir }),
      { agentDir }
    )
    const installed = join(agentDir, 'packages', 'skill', 'team-skill', '1.0.0')
    assert.equal(existsSync(join(installed, 'SKILL.md')), true)
    const installedSource = JSON.parse(readFileSync(join(installed, '.source.json'), 'utf8'))
    assert.equal(installedSource.trust, 'imported')
    assert.deepEqual(installedSource.teamSource, {
      teamId: source.teamId,
      teamName: source.teamName,
      teamKeyId: source.teamKeyId,
      release: 3,
      sharing: 'forwardable'
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('keeps a successfully pulled registry cached but blocks withdrawn and never-pulled sources', async () => {
  const { root, agentDir } = sandbox()
  try {
    const unavailable = teamSource({
      id: 'team-source-unavailable',
      teamId: 'unavailable-team',
      teamName: 'Unavailable',
      status: {
        lastSuccessfulRelease: 3,
        lastCheckedAt: '2026-11-04T02:00:00.000Z',
        lastErrorCode: 'NOT_A_MEMBER',
        withdrawnReleases: [],
        announcements: [],
        resources: { 'skill:team-skill': { sharing: 'forwardable' } },
        credentialConflicts: [],
        skippedProviders: []
      }
    })
    const withdrawn = teamSource({
      id: 'team-source-withdrawn',
      teamId: 'withdrawn-team',
      teamName: 'Withdrawn',
      status: {
        lastSuccessfulRelease: 3,
        lastCheckedAt: '2026-11-04T02:00:00.000Z',
        lastErrorCode: null,
        withdrawnReleases: [3],
        announcements: [],
        resources: { 'skill:team-skill': { sharing: 'forwardable' } },
        credentialConflicts: [],
        skippedProviders: []
      }
    })
    const neverPulled = teamSource({
      id: 'team-source-new',
      teamId: 'new-team',
      teamName: 'New',
      status: {
        lastSuccessfulRelease: null,
        lastCheckedAt: null,
        lastErrorCode: null,
        withdrawnReleases: [],
        announcements: [],
        resources: {},
        credentialConflicts: [],
        skippedProviders: []
      }
    })
    writeInstallableRegistry(teamRegistryDir(agentDir, unavailable))
    writeInstallableRegistry(teamRegistryDir(agentDir, withdrawn))
    const options = {
      agentDir,
      loadOfficialRegistry: async () => officialRegistry(agentDir),
      loadTeamSources: () => [unavailable, withdrawn, neverPulled]
    }

    const listed = await listKnownRegistries(options)
    const teams = listed.registries.filter((registry) => registry.kind === 'team')
    assert.deepEqual(
      teams.map((registry) => registry.status),
      ['cached', 'unavailable', 'unavailable']
    )
    assert.match(teams[0]?.notice ?? '', /NOT_A_MEMBER/)
    assert.equal(teams[0]?.error, undefined)
    assert.match(teams[1]?.error ?? '', /版本 3 已撤回/)
    assert.match(teams[2]?.error ?? '', /尚无成功拉取/)

    const loaded = await loadKnownRegistryIndexes(options)
    const cached = loaded.registries.find((registry) => registry.source?.kind === 'team')
    assert.equal(cached?.id, unavailable.id)
    assert.equal(cached?.status, 'cached')
    assert.match(cached?.notice ?? '', /NOT_A_MEMBER/)
    assert.doesNotMatch(loaded.errors.join('\n'), /NOT_A_MEMBER/)
    assert.match(loaded.errors.join('\n'), /版本 3 已撤回/)
    assert.match(loaded.errors.join('\n'), /尚无成功拉取/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
