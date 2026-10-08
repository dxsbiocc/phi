import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { stringify as stringifyYaml } from 'yaml'

import { createDeterministicTarGz } from '../src/main/agent/packages/archive'
import {
  applyPackageUpdate,
  applyPackageUpdates,
  computePackageUpdates,
  installPackages,
  listInstalledPackages,
  listPackageUpdates,
  planInstall,
  type InstalledPackage,
  type LocalRegistry,
  type RegistryPackageEntry,
  type RegistryTrustTier
} from '../src/main/agent/packages/installer'

interface EntryOptions {
  dependsOn?: RegistryPackageEntry['dependsOn']
  minAppVersion?: string
  coreTools?: string[]
}

function sandbox(): { root: string; agentDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'phi-package-updates-'))
  return { root, agentDir: join(root, 'agent') }
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function registry(
  root: string,
  id: string,
  trust: RegistryTrustTier,
  packages: RegistryPackageEntry[]
): LocalRegistry {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  return {
    id,
    dir,
    trust,
    schemaVersion: 1,
    generatedAt: '2026-10-02T00:00:00.000Z',
    packages
  }
}

function skillEntry(
  registryDir: string,
  id: string,
  version: string,
  options: EntryOptions = {}
): RegistryPackageEntry {
  const manifest = {
    schemaVersion: 1,
    id,
    type: 'skill',
    version,
    title: id,
    summary: `${id} update fixture.`,
    ...(options.dependsOn ? { dependsOn: options.dependsOn } : {}),
    ...(options.minAppVersion ? { minAppVersion: options.minAppVersion } : {}),
    ...(options.coreTools ? { requires: { coreTools: options.coreTools } } : {}),
    files: 'files.json'
  } as const
  const packageFiles = new Map<string, Buffer>([
    [
      'SKILL.md',
      Buffer.from(`---\nname: ${id}\ndescription: ${id} update fixture.\n---\n\n# ${id}\n`)
    ],
    ['phi-package.yaml', Buffer.from(stringifyYaml(manifest))]
  ])
  const listed = [...packageFiles]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([path, data]) => ({ path, size: data.length, sha256: sha256(data) }))
  const archive = createDeterministicTarGz([
    ...[...packageFiles].map(([path, data]) => ({ path, data })),
    {
      path: 'files.json',
      data: Buffer.from(`${JSON.stringify({ version: 1, files: listed }, null, 2)}\n`)
    }
  ])
  const archiveName = `skill-${id}-${version}.tar.gz`
  writeFileSync(join(registryDir, archiveName), archive)
  return {
    id,
    type: 'skill',
    version,
    title: id,
    summary: `${id} update fixture.`,
    archive: archiveName,
    sha256: sha256(archive),
    size: archive.length,
    dependsOn: options.dependsOn ?? [],
    ...(options.minAppVersion ? { minAppVersion: options.minAppVersion } : {}),
    ...(options.coreTools ? { requires: { coreTools: options.coreTools } } : {})
  }
}

function installed(
  id: string,
  type: InstalledPackage['type'],
  trust: RegistryTrustTier,
  registryId = 'source'
): InstalledPackage {
  return {
    id,
    type,
    version: '1.0.0',
    title: id,
    summary: `${id} installed fixture.`,
    dir: `/packages/${type}/${id}/1.0.0`,
    installedAt: '2026-10-02T00:00:00.000Z',
    installedBy: 'user',
    registry: registryId,
    sha256: '0'.repeat(64),
    trust
  }
}

test('discovers the highest eligible update at an equal-or-higher trust tier', () => {
  const { root } = sandbox()
  try {
    const official = registry(root, 'official', 'official', [])
    official.packages.push(
      skillEntry(official.dir, 'alpha-skill', '1.5.0'),
      skillEntry(official.dir, 'alpha-skill', '2.0.0')
    )
    const imported = registry(root, 'imported', 'imported', [])
    imported.packages.push(skillEntry(imported.dir, 'alpha-skill', '3.0.0'))
    assert.deepEqual(
      computePackageUpdates([installed('alpha-skill', 'skill', 'official')], [imported, official], {
        appVersion: '1.0.0'
      }).map((update) => [update.newVersion, update.registryId, update.trust]),
      [['2.0.0', 'official', 'official']]
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('prefers the recorded source registry before a newer alternate registry', () => {
  const { root } = sandbox()
  try {
    const preferred = registry(root, 'preferred', 'official', [])
    preferred.packages.push(skillEntry(preferred.dir, 'alpha-skill', '1.5.0'))
    const alternate = registry(root, 'alternate', 'builtin', [])
    alternate.packages.push(skillEntry(alternate.dir, 'alpha-skill', '2.0.0'))
    const updates = computePackageUpdates(
      [installed('alpha-skill', 'skill', 'official', 'preferred')],
      [alternate, preferred],
      { appVersion: '1.0.0' }
    )
    assert.equal(updates[0]?.newVersion, '1.5.0')
    assert.equal(updates[0]?.registryId, 'preferred')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('filters incompatible updates and lets legacy bundled content move to signed sources', () => {
  const { root } = sandbox()
  try {
    const source = registry(root, 'source', 'official', [])
    source.packages.push(
      skillEntry(source.dir, 'too-new', '2.0.0', { minAppVersion: '9.0.0' }),
      skillEntry(source.dir, 'missing-tool', '2.0.0', { coreTools: ['not_a_core_tool'] }),
      {
        ...skillEntry(source.dir, 'bundled-plugin', '2.0.0'),
        type: 'plugin'
      },
      {
        ...skillEntry(source.dir, 'bundled-wrapper', '2.0.0'),
        type: 'wrapper'
      },
      {
        ...skillEntry(source.dir, 'bundled-connector', '2.0.0'),
        type: 'mcp'
      }
    )
    const imported = registry(root, 'imported', 'imported', [])
    imported.packages.push({
      ...skillEntry(imported.dir, 'bundled-connector', '3.0.0'),
      type: 'mcp'
    })
    const updates = computePackageUpdates(
      [
        installed('too-new', 'skill', 'official'),
        installed('missing-tool', 'skill', 'official'),
        installed('bundled-plugin', 'plugin', 'builtin'),
        installed('bundled-wrapper', 'wrapper', 'builtin'),
        installed('bundled-connector', 'mcp', 'builtin')
      ],
      [source, imported],
      { appVersion: '1.0.0' }
    )
    assert.deepEqual(
      updates.map((entry) => entry.id),
      ['bundled-connector', 'bundled-plugin', 'bundled-wrapper']
    )
    assert.ok(updates.every((entry) => entry.trust === 'official' && entry.newVersion === '2.0.0'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('applies one update and all updates through dependency-safe upgrade order', async () => {
  const { root, agentDir } = sandbox()
  try {
    const source = registry(root, 'source', 'imported', [])
    const alphaV1 = skillEntry(source.dir, 'alpha-skill', '1.0.0')
    const betaV1 = skillEntry(source.dir, 'beta-skill', '1.0.0')
    source.packages.push(alphaV1, betaV1)
    await installPackages(
      planInstall(source, { type: 'skill', id: 'alpha-skill', version: '1.0.0' }, { agentDir }),
      { agentDir }
    )
    await installPackages(
      planInstall(source, { type: 'skill', id: 'beta-skill', version: '1.0.0' }, { agentDir }),
      { agentDir }
    )

    const alphaV2 = skillEntry(source.dir, 'alpha-skill', '2.0.0', {
      dependsOn: [{ type: 'skill', id: 'beta-skill', version: '^2.0.0' }]
    })
    const betaV2 = skillEntry(source.dir, 'beta-skill', '2.0.0')
    source.packages.push(alphaV2, betaV2)
    const updates = listPackageUpdates([source], { agentDir, appVersion: '1.0.0' })
    const betaUpdate = updates.find((update) => update.id === 'beta-skill')
    assert(betaUpdate)
    await applyPackageUpdate(betaUpdate, [source], { agentDir, appVersion: '1.0.0' })
    assert.equal(
      listInstalledPackages({ agentDir }).find((item) => item.id === 'beta-skill')?.version,
      '2.0.0'
    )

    // Reinstall the old beta so apply-all has to order beta before alpha even though alpha is first.
    rmSync(agentDir, { recursive: true, force: true })
    source.packages = [alphaV1, betaV1]
    await installPackages(
      planInstall(source, { type: 'skill', id: 'alpha-skill', version: '1.0.0' }, { agentDir }),
      { agentDir }
    )
    await installPackages(
      planInstall(source, { type: 'skill', id: 'beta-skill', version: '1.0.0' }, { agentDir }),
      { agentDir }
    )
    source.packages.push(alphaV2, betaV2)
    const pending = listPackageUpdates([source], { agentDir, appVersion: '1.0.0' })
    const prepared: string[] = []
    const result = await applyPackageUpdates(pending, [source], {
      agentDir,
      appVersion: '1.0.0',
      preparePackage: async (registry, request) => {
        // A remote prepare step uses the current installed state, so alpha can only
        // resolve its ^2 dependency after beta's upgrade has already committed.
        planInstall(registry, request, { agentDir, appVersion: '1.0.0' })
        prepared.push(request.id)
      }
    })
    assert.deepEqual(prepared, ['beta-skill', 'alpha-skill'])
    assert.deepEqual(
      result.map((item) => [item.id, item.version]),
      [
        ['alpha-skill', '2.0.0'],
        ['beta-skill', '2.0.0']
      ]
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
