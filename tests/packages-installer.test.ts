import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { gunzipSync, gzipSync } from 'node:zlib'

import { stringify as stringifyYaml } from 'yaml'

import { buildRegistry } from '../scripts/packages/build-registry'
import { createDeterministicTarGz, parseTarGz } from '../src/main/agent/packages/archive'
import {
  cleanupStalePackageStaging,
  installPackages,
  listInstalledPackages,
  planInstall,
  readRegistry,
  uninstallPackage,
  upgradePackage,
  type LocalRegistry,
  type RegistryPackageEntry
} from '../src/main/agent/packages/installer'
import { createRuntimeResourceLoader } from '../src/main/agent/runtime/runtime-adapter'
import { loadedPlugins } from '../src/main/agent/plugins/loader'
import { pluginVersionDir } from '../src/main/agent/plugins/store'
import { readEnvironmentIndex } from '../src/main/agent/envs'

interface SkillOptions {
  version?: string
  dependsOn?: Array<{ id: string; type: 'skill' | 'plugin'; version: string }>
  minAppVersion?: string
  requires?: { coreTools: string[] }
  environment?: string
}

function sandbox(): { root: string; agentDir: string; registryDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'phi-packages-installer-'))
  const agentDir = join(root, 'agent')
  const registryDir = join(root, 'registry')
  mkdirSync(registryDir, { recursive: true })
  return { root, agentDir, registryDir }
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true })
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function skillEntry(
  registryDir: string,
  id: string,
  options: SkillOptions = {}
): RegistryPackageEntry {
  const version = options.version ?? '1.0.0'
  const manifest = {
    schemaVersion: 1,
    id,
    type: 'skill',
    version,
    title: id,
    summary: `${id} package.`,
    ...(options.minAppVersion ? { minAppVersion: options.minAppVersion } : {}),
    ...(options.requires ? { requires: options.requires } : {}),
    ...(options.dependsOn ? { dependsOn: options.dependsOn } : {}),
    files: 'files.json'
  } as const
  const files = new Map<string, Buffer>([
    [
      'SKILL.md',
      Buffer.from(
        `---\nname: ${id}\ndescription: ${id} package.\n${
          options.environment ? `phi:\n  environment: ${options.environment}\n` : ''
        }---\n\n# ${id}\n`
      )
    ],
    ['phi-package.yaml', Buffer.from(stringifyYaml(manifest))]
  ])
  if (options.environment) files.set('scripts/run.py', Buffer.from('print("ok")\n'))
  const list = [...files]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([path, data]) => ({ path, size: data.length, sha256: sha256(data) }))
  const archive = createDeterministicTarGz([
    ...[...files].map(([path, data]) => ({ path, data })),
    {
      path: 'files.json',
      data: Buffer.from(`${JSON.stringify({ version: 1, files: list }, null, 2)}\n`)
    }
  ])
  const archiveName = `skill-${id}-${version}.tar.gz`
  writeFileSync(join(registryDir, archiveName), archive)
  return {
    id,
    type: 'skill',
    version,
    title: id,
    summary: `${id} package.`,
    archive: archiveName,
    sha256: sha256(archive),
    size: archive.length,
    dependsOn: options.dependsOn ?? [],
    ...(options.minAppVersion ? { minAppVersion: options.minAppVersion } : {}),
    ...(options.requires ? { requires: options.requires } : {})
  }
}

function writeIndex(registryDir: string, packages: RegistryPackageEntry[]): LocalRegistry {
  writeFileSync(
    join(registryDir, 'index.json'),
    `${JSON.stringify({ schemaVersion: 1, generatedAt: '2026-10-02T00:00:00.000Z', packages }, null, 2)}\n`
  )
  return readRegistry(registryDir)
}

function rewriteArchive(
  registryDir: string,
  entry: RegistryPackageEntry,
  mutate: (files: Map<string, Buffer>) => void
): RegistryPackageEntry {
  const path = join(registryDir, entry.archive)
  const files = new Map(
    parseTarGz(readFileSync(path))
      .filter((item) => item.type === 'file')
      .map((item) => [item.path, item.data] as const)
  )
  mutate(files)
  const archive = createDeterministicTarGz(
    [...files].map(([filePath, data]) => ({ path: filePath, data }))
  )
  writeFileSync(path, archive)
  return { ...entry, size: archive.length, sha256: sha256(archive) }
}

function recalculateTarHeaderChecksum(header: Buffer): void {
  header.fill(0x20, 148, 156)
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  header.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii')
  header[154] = 0
  header[155] = 0x20
}

function initializeFixtureRepository(root: string): void {
  const skillDir = join(root, 'resources', 'skills', 'alpha-skill')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    '---\nname: alpha-skill\ndescription: Alpha package.\nmetadata: { version: 1.2.3 }\n---\n# Alpha\n'
  )
  const pluginDir = join(root, 'resources', 'plugins', 'alpha-plugin')
  const pluginSkillDir = join(pluginDir, 'skills', 'plugin-skill')
  mkdirSync(pluginSkillDir, { recursive: true })
  writeFileSync(
    join(pluginDir, 'phi-package.yaml'),
    stringifyYaml({
      schemaVersion: 1,
      id: 'alpha-plugin',
      type: 'plugin',
      version: '1.0.0',
      title: 'Alpha plugin',
      summary: 'Alpha plugin.',
      toolPrefix: 'alphap',
      components: { skills: ['skills/plugin-skill'] }
    })
  )
  writeFileSync(
    join(pluginSkillDir, 'SKILL.md'),
    '---\nname: plugin-skill\ndescription: Plugin package skill.\n---\n# Plugin skill\n'
  )
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  execFileSync('git', ['add', 'resources'], { cwd: root })
}

test('installs and discovers a skill and plugin from a built local registry', async () => {
  const { root, agentDir, registryDir } = sandbox()
  try {
    initializeFixtureRepository(root)
    buildRegistry({ repoRoot: root, outDir: registryDir, generatedAt: '2026-10-02T00:00:00Z' })
    const registry = readRegistry(registryDir)

    await installPackages(
      planInstall(registry, { type: 'skill', id: 'alpha-skill' }, { agentDir }),
      {
        agentDir
      }
    )
    await installPackages(
      planInstall(registry, { type: 'plugin', id: 'alpha-plugin' }, { agentDir }),
      { agentDir }
    )

    assert.deepEqual(
      listInstalledPackages({ agentDir }).map((item) => [item.type, item.id, item.version]),
      [
        ['plugin', 'alpha-plugin', '1.0.0'],
        ['skill', 'alpha-skill', '1.2.3']
      ]
    )
    const plugin = loadedPlugins({ agentDir })[0]
    assert.equal(plugin?.dir, pluginVersionDir('alpha-plugin', '1.0.0', agentDir))
    assert.equal(existsSync(join(plugin?.dir ?? '', '.source.json')), true)
    assert.equal(
      JSON.parse(readFileSync(join(plugin?.dir ?? '', '.source.json'), 'utf8')).trust,
      'imported'
    )
    assert.deepEqual(
      listInstalledPackages({ agentDir }).map((item) => item.trust),
      ['imported', 'imported']
    )

    const loader = createRuntimeResourceLoader({ cwd: root, agentDir })
    await loader.reload()
    const skill = loader.getSkills().skills.find((item) => item.name === 'alpha-skill')
    assert(skill)
    assert.match(skill.filePath, /packages\/skill\/alpha-skill\/1\.2\.3\/SKILL\.md$/)
    assert.equal(skill.sourceInfo.source, 'installed-package')

    uninstallPackage('plugin', 'alpha-plugin', { agentDir })
    uninstallPackage('skill', 'alpha-skill', { agentDir })
    assert.deepEqual(listInstalledPackages({ agentDir }), [])
  } finally {
    cleanup(root)
  }
})

test('reads legacy source metadata as builtin only for the bundled registry', async () => {
  const { root, agentDir, registryDir } = sandbox()
  try {
    const registry = writeIndex(registryDir, [skillEntry(registryDir, 'legacy-skill')])
    await installPackages(
      planInstall(registry, { type: 'skill', id: 'legacy-skill' }, { agentDir }),
      { agentDir }
    )
    const installed = listInstalledPackages({ agentDir })[0]
    assert(installed)
    const sourcePath = join(installed.dir, '.source.json')
    const source = JSON.parse(readFileSync(sourcePath, 'utf8')) as Record<string, unknown>
    delete source.trust
    source.registry = 'builtin'
    writeFileSync(sourcePath, `${JSON.stringify(source, null, 2)}\n`)
    assert.equal(listInstalledPackages({ agentDir })[0]?.trust, 'builtin')

    source.registry = registryDir
    writeFileSync(sourcePath, `${JSON.stringify(source, null, 2)}\n`)
    assert.equal(listInstalledPackages({ agentDir })[0]?.trust, 'imported')
  } finally {
    cleanup(root)
  }
})

test('an installed skill overrides its bundled copy and owns its environment reference', async () => {
  const { root, agentDir, registryDir } = sandbox()
  try {
    const registry = writeIndex(registryDir, [
      skillEntry(registryDir, 'scanpy', { environment: 'phi:python@1' })
    ])
    const plan = planInstall(registry, { type: 'skill', id: 'scanpy' }, { agentDir })
    assert.deepEqual(plan.environments, ['phi:python@1'])
    await installPackages(plan, { agentDir })

    const loader = createRuntimeResourceLoader({ cwd: root, agentDir })
    await loader.reload()
    const scanpy = loader.getSkills().skills.filter((item) => item.name === 'scanpy')
    assert.equal(scanpy.length, 1)
    assert.equal(scanpy[0]?.sourceInfo.source, 'installed-package')

    const runtimeRoot = join(agentDir, 'runtime')
    const environment = Object.values(readEnvironmentIndex(runtimeRoot).environments).find(
      (entry) => entry.name === 'phi-python'
    )
    assert(environment?.referrers.includes('skill:scanpy'))

    uninstallPackage('skill', 'scanpy', { agentDir })
    const after = Object.values(readEnvironmentIndex(runtimeRoot).environments).find(
      (entry) => entry.name === 'phi-python'
    )
    assert.deepEqual(after?.referrers, [])
  } finally {
    cleanup(root)
  }
})

test('rejects archive sha256 and size mismatches', async () => {
  const { root, agentDir, registryDir } = sandbox()
  try {
    const entry = skillEntry(registryDir, 'alpha-skill')
    const shaRegistry = writeIndex(registryDir, [{ ...entry, sha256: '0'.repeat(64) }])
    await assert.rejects(
      installPackages(planInstall(shaRegistry, { type: 'skill', id: 'alpha-skill' }, { agentDir })),
      /哈希/
    )
    const sizeRegistry = writeIndex(registryDir, [{ ...entry, size: entry.size + 1 }])
    await assert.rejects(
      installPackages(
        planInstall(sizeRegistry, { type: 'skill', id: 'alpha-skill' }, { agentDir })
      ),
      /大小/
    )
  } finally {
    cleanup(root)
  }
})

test('rejects traversal, absolute, and link tar entries before extraction', async (t) => {
  for (const attack of ['../escape', '/tmp/phi-package-escape']) {
    await t.test(attack, async () => {
      const { root, agentDir, registryDir } = sandbox()
      try {
        const original = skillEntry(registryDir, 'alpha-skill')
        const entry = rewriteArchive(registryDir, original, (files) => {
          files.set(attack, Buffer.from('escape'))
        })
        const registry = writeIndex(registryDir, [entry])
        await assert.rejects(
          installPackages(
            planInstall(registry, { type: 'skill', id: 'alpha-skill' }, { agentDir })
          ),
          /路径/
        )
      } finally {
        cleanup(root)
      }
    })
  }

  await t.test('symbolic link', async () => {
    const { root, agentDir, registryDir } = sandbox()
    try {
      const original = skillEntry(registryDir, 'alpha-skill')
      const path = join(registryDir, original.archive)
      const tar = gunzipSync(readFileSync(path))
      tar[156] = '2'.charCodeAt(0)
      recalculateTarHeaderChecksum(tar.subarray(0, 512))
      const archive = gzipSync(tar, { level: 9 })
      writeFileSync(path, archive)
      const registry = writeIndex(registryDir, [
        { ...original, size: archive.length, sha256: sha256(archive) }
      ])
      await assert.rejects(
        installPackages(planInstall(registry, { type: 'skill', id: 'alpha-skill' }, { agentDir })),
        /链接/
      )
    } finally {
      cleanup(root)
    }
  })
})

test('checks files.json for extra and missing files', async (t) => {
  await t.test('extra file', async () => {
    const { root, agentDir, registryDir } = sandbox()
    try {
      const entry = rewriteArchive(registryDir, skillEntry(registryDir, 'alpha-skill'), (files) => {
        files.set('extra.txt', Buffer.from('extra'))
      })
      const registry = writeIndex(registryDir, [entry])
      await assert.rejects(
        installPackages(planInstall(registry, { type: 'skill', id: 'alpha-skill' }, { agentDir })),
        /未列入/
      )
    } finally {
      cleanup(root)
    }
  })
  await t.test('listed file missing', async () => {
    const { root, agentDir, registryDir } = sandbox()
    try {
      const entry = rewriteArchive(registryDir, skillEntry(registryDir, 'alpha-skill'), (files) => {
        files.delete('SKILL.md')
      })
      const registry = writeIndex(registryDir, [entry])
      await assert.rejects(
        installPackages(planInstall(registry, { type: 'skill', id: 'alpha-skill' }, { agentDir })),
        /不存在/
      )
    } finally {
      cleanup(root)
    }
  })
})

test('rejects a manifest that disagrees with the registry index', async () => {
  const { root, agentDir, registryDir } = sandbox()
  try {
    const entry = rewriteArchive(registryDir, skillEntry(registryDir, 'alpha-skill'), (files) => {
      const manifest = Buffer.from(
        stringifyYaml({
          schemaVersion: 1,
          id: 'alpha-skill',
          type: 'skill',
          version: '2.0.0',
          title: 'alpha-skill',
          summary: 'alpha-skill package.',
          files: 'files.json'
        })
      )
      files.set('phi-package.yaml', manifest)
      const list = JSON.parse(files.get('files.json')?.toString('utf8') ?? '{}') as {
        files: Array<{ path: string; size: number; sha256: string }>
      }
      const item = list.files.find((file) => file.path === 'phi-package.yaml')
      assert(item)
      item.size = manifest.length
      item.sha256 = sha256(manifest)
      files.set(
        'files.json',
        Buffer.from(`${JSON.stringify({ version: 1, files: list.files }, null, 2)}\n`)
      )
    })
    const registry = writeIndex(registryDir, [entry])
    await assert.rejects(
      installPackages(planInstall(registry, { type: 'skill', id: 'alpha-skill' }, { agentDir })),
      /清单与注册表不匹配/
    )
  } finally {
    cleanup(root)
  }
})

test('resolves dependencies, checks compatibility, refuses dependent removal, and collects orphans', async () => {
  const { root, agentDir, registryDir } = sandbox()
  try {
    const dependency = skillEntry(registryDir, 'beta-skill')
    const rootEntry = skillEntry(registryDir, 'alpha-skill', {
      dependsOn: [{ id: 'beta-skill', type: 'skill', version: '^1.0.0' }],
      requires: { coreTools: ['skill_run', 'env_request'] }
    })
    const registry = writeIndex(registryDir, [rootEntry, dependency])
    const plan = planInstall(registry, { type: 'skill', id: 'alpha-skill' }, { agentDir })
    assert.deepEqual(
      plan.packages.map((item) => item.id),
      ['beta-skill', 'alpha-skill']
    )
    await installPackages(plan, { agentDir })
    assert.equal(
      listInstalledPackages({ agentDir }).find((item) => item.id === 'beta-skill')?.installedBy,
      'dependency'
    )
    assert.throws(() => uninstallPackage('skill', 'beta-skill', { agentDir }), /仍依赖/)
    uninstallPackage('skill', 'alpha-skill', { agentDir })
    assert.deepEqual(listInstalledPackages({ agentDir }), [])

    const tooNew = writeIndex(registryDir, [
      skillEntry(registryDir, 'new-skill', { minAppVersion: '9.0.0' })
    ])
    assert.throws(
      () => planInstall(tooNew, { type: 'skill', id: 'new-skill' }, { agentDir }),
      /应用版本/
    )
    const missingTool = writeIndex(registryDir, [
      skillEntry(registryDir, 'tool-skill', { requires: { coreTools: ['missing_tool'] } })
    ])
    assert.throws(
      () => planInstall(missingTool, { type: 'skill', id: 'tool-skill' }, { agentDir }),
      /核心工具/
    )
  } finally {
    cleanup(root)
  }
})

test('refuses missing, conflicting, and cyclic dependencies', async () => {
  const { root, agentDir, registryDir } = sandbox()
  try {
    const missing = skillEntry(registryDir, 'missing-root', {
      dependsOn: [{ id: 'absent-skill', type: 'skill', version: '^1.0.0' }]
    })
    assert.throws(
      () =>
        planInstall(
          writeIndex(registryDir, [missing]),
          { type: 'skill', id: 'missing-root' },
          {
            agentDir
          }
        ),
      /依赖或版本冲突/
    )

    const shared = skillEntry(registryDir, 'shared-skill', { version: '1.5.0' })
    const left = skillEntry(registryDir, 'left-skill', {
      dependsOn: [{ id: 'shared-skill', type: 'skill', version: '^1.0.0' }]
    })
    const conflictRoot = skillEntry(registryDir, 'conflict-root', {
      dependsOn: [
        { id: 'left-skill', type: 'skill', version: '^1.0.0' },
        { id: 'shared-skill', type: 'skill', version: '^2.0.0' }
      ]
    })
    assert.throws(
      () =>
        planInstall(
          writeIndex(registryDir, [shared, left, conflictRoot]),
          { type: 'skill', id: 'conflict-root' },
          { agentDir }
        ),
      /依赖或版本冲突/
    )

    const installedV1 = skillEntry(registryDir, 'installed-dep', { version: '1.0.0' })
    const initialRegistry = writeIndex(registryDir, [installedV1])
    await installPackages(
      planInstall(initialRegistry, { type: 'skill', id: 'installed-dep' }, { agentDir }),
      { agentDir }
    )
    const availableV2 = skillEntry(registryDir, 'installed-dep', { version: '2.0.0' })
    const requiresV2 = skillEntry(registryDir, 'requires-v2', {
      dependsOn: [{ id: 'installed-dep', type: 'skill', version: '^2.0.0' }]
    })
    assert.throws(
      () =>
        planInstall(
          writeIndex(registryDir, [availableV2, requiresV2]),
          { type: 'skill', id: 'requires-v2' },
          { agentDir }
        ),
      /依赖或版本冲突/
    )

    const cycleA = skillEntry(registryDir, 'cycle-a', {
      dependsOn: [{ id: 'cycle-b', type: 'skill', version: '^1.0.0' }]
    })
    const cycleB = skillEntry(registryDir, 'cycle-b', {
      dependsOn: [{ id: 'cycle-a', type: 'skill', version: '^1.0.0' }]
    })
    assert.throws(
      () =>
        planInstall(
          writeIndex(registryDir, [cycleA, cycleB]),
          { type: 'skill', id: 'cycle-a' },
          { agentDir }
        ),
      /循环依赖/
    )
  } finally {
    cleanup(root)
  }
})

test('upgrades a skill atomically and removes the old version', async () => {
  const { root, agentDir, registryDir } = sandbox()
  try {
    const first = skillEntry(registryDir, 'alpha-skill', { version: '1.0.0' })
    const second = skillEntry(registryDir, 'alpha-skill', { version: '2.0.0' })
    const registry = writeIndex(registryDir, [first, second])
    await installPackages(
      planInstall(registry, { type: 'skill', id: 'alpha-skill', version: '1.0.0' }, { agentDir }),
      { agentDir }
    )
    await upgradePackage(
      registry,
      { type: 'skill', id: 'alpha-skill', version: '2.0.0' },
      { agentDir }
    )
    assert.equal(listInstalledPackages({ agentDir })[0]?.version, '2.0.0')
    assert.deepEqual(readdirSync(join(agentDir, 'packages', 'skill', 'alpha-skill')), ['2.0.0'])
    assert.throws(
      () =>
        planInstall(registry, { type: 'skill', id: 'alpha-skill', version: '1.0.0' }, { agentDir }),
      /拒绝降级/
    )
  } finally {
    cleanup(root)
  }
})

test('removes stale staging directories and preserves fresh ones', () => {
  const { root, agentDir } = sandbox()
  try {
    const staging = join(agentDir, '.staging')
    const stale = join(staging, 'stale')
    const fresh = join(staging, 'fresh')
    mkdirSync(stale, { recursive: true })
    mkdirSync(fresh, { recursive: true })
    const now = new Date('2026-10-02T12:00:00Z')
    const old = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000)
    utimesSync(stale, old, old)
    utimesSync(fresh, now, now)
    assert.deepEqual(cleanupStalePackageStaging({ agentDir, now: () => now }), [stale])
    assert.equal(existsSync(stale), false)
    assert.equal(existsSync(fresh), true)
  } finally {
    cleanup(root)
  }
})
