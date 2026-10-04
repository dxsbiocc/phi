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
  listInstalledPackages,
  planInstall,
  uninstallPackage,
  upgradePackage,
  type LocalRegistry,
  type RegistryPackageEntry
} from '../src/main/agent/packages/installer'
import { readWrapperTreeState } from '../src/main/agent/packages/wrapper-tree'

interface WrapperOptions {
  version?: string
  files: Record<string, string>
  dependsOn?: Array<{ id: string; type: 'wrapper'; version: string }>
}

function sandbox(): { root: string; agentDir: string; registryDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'phi-wrapper-tree-'))
  const agentDir = join(root, 'agent')
  const registryDir = join(root, 'registry')
  mkdirSync(registryDir, { recursive: true })
  return { root, agentDir, registryDir }
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function wrapperEntry(
  registryDir: string,
  id: string,
  options: WrapperOptions
): RegistryPackageEntry {
  const version = options.version ?? '1.0.0'
  const manifest = Buffer.from(
    stringifyYaml({
      schemaVersion: 1,
      id,
      type: 'wrapper',
      version,
      title: id,
      summary: `${id} wrapper package.`,
      ...(options.dependsOn ? { dependsOn: options.dependsOn } : {}),
      files: 'files.json'
    })
  )
  const files = new Map<string, Buffer>([
    ...Object.entries(options.files).map(([path, text]) => [path, Buffer.from(text)] as const),
    ['phi-package.yaml', manifest]
  ])
  const listed = [...files]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, data]) => ({ path, size: data.length, sha256: sha256(data) }))
  const archive = createDeterministicTarGz([
    ...[...files].map(([path, data]) => ({ path, data })),
    {
      path: 'files.json',
      data: Buffer.from(`${JSON.stringify({ version: 1, files: listed }, null, 2)}\n`)
    }
  ])
  const archiveName = `wrapper-${id}-${version}.tar.gz`
  writeFileSync(join(registryDir, archiveName), archive)
  return {
    id,
    type: 'wrapper',
    version,
    title: id,
    summary: `${id} wrapper package.`,
    archive: archiveName,
    sha256: sha256(archive),
    size: archive.length,
    dependsOn: options.dependsOn ?? []
  }
}

function registry(registryDir: string, packages: RegistryPackageEntry[]): LocalRegistry {
  return {
    id: registryDir,
    dir: registryDir,
    trust: 'imported',
    schemaVersion: 1,
    generatedAt: '2026-10-02T00:00:00.000Z',
    packages
  }
}

test('plans MCP package installation through the generic package solver', () => {
  const { root, agentDir, registryDir } = sandbox()
  try {
    const source = registry(registryDir, [
      {
        id: 'example-mcp',
        type: 'mcp',
        version: '1.0.0',
        title: 'Example MCP',
        summary: 'Example MCP package.',
        archive: 'mcp-example-mcp-1.0.0.tar.gz',
        sha256: '0'.repeat(64),
        size: 0,
        dependsOn: []
      }
    ])
    const plan = planInstall(source, { type: 'mcp', id: 'example-mcp' }, { agentDir })
    assert.deepEqual(plan.root, { type: 'mcp', id: 'example-mcp', version: '1.0.0' })
    assert.deepEqual(
      plan.packages.map((entry) => entry.id),
      ['example-mcp']
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('installs verified wrapper package files into the assembled tree', async () => {
  const { root, agentDir, registryDir } = sandbox()
  try {
    const custom = join(agentDir, 'wrappers', 'custom', 'my-wrapper', 'wrapper.yaml')
    mkdirSync(join(custom, '..'), { recursive: true })
    writeFileSync(custom, 'user-authored\n')
    const entry = wrapperEntry(registryDir, 'module-nf-core-samtools', {
      files: {
        'modules/nf-core/samtools/faidx/main.nf': 'process FAIDX {}\n',
        'modules/nf-core/samtools/faidx/wrapper/wrapper.yaml': `id: nf-core/modules/samtools-faidx
name: samtools faidx
summary: Index a FASTA file.
params: {}
outputs:
  index:
    type: path
    path: results/index.fai
    primary: true
`
      }
    })
    const source = registry(registryDir, [entry])

    await installPackages(planInstall(source, { type: 'wrapper', id: entry.id }, { agentDir }), {
      agentDir
    })

    assert.equal(
      readFileSync(
        join(agentDir, 'wrappers', 'tree', 'modules/nf-core/samtools/faidx/main.nf'),
        'utf8'
      ),
      'process FAIDX {}\n'
    )
    assert.equal(readFileSync(custom, 'utf8'), 'user-authored\n')
    assert.deepEqual(readWrapperTreeState(agentDir).packages[entry.id]?.paths, [
      'modules/nf-core/samtools/faidx/main.nf',
      'modules/nf-core/samtools/faidx/wrapper/wrapper.yaml'
    ])
    assert.deepEqual(
      listInstalledPackages({ agentDir }).map((item) => [item.type, item.id, item.version]),
      [['wrapper', entry.id, '1.0.0']]
    )
    assert.equal(existsSync(join(agentDir, 'wrappers', 'tree', 'phi-package.yaml')), false)
    assert.equal(existsSync(join(agentDir, 'wrappers', 'tree', 'files.json')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('refuses wrapper paths already owned by another package', async () => {
  const { root, agentDir, registryDir } = sandbox()
  try {
    const path = 'modules/nf-core/shared/main.nf'
    const first = wrapperEntry(registryDir, 'module-nf-core-alpha', {
      files: { [path]: 'alpha\n' }
    })
    const second = wrapperEntry(registryDir, 'module-nf-core-beta', {
      files: { [path]: 'beta\n' }
    })
    const source = registry(registryDir, [first, second])
    await installPackages(planInstall(source, { type: 'wrapper', id: first.id }, { agentDir }), {
      agentDir
    })

    await assert.rejects(
      installPackages(planInstall(source, { type: 'wrapper', id: second.id }, { agentDir }), {
        agentDir
      }),
      /module-nf-core-alpha.*拥有/
    )
    assert.equal(readFileSync(join(agentDir, 'wrappers', 'tree', path), 'utf8'), 'alpha\n')
    assert.equal(readWrapperTreeState(agentDir).packages[second.id], undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('refuses wrapper paths nested above or below another package path', async () => {
  const { root, agentDir, registryDir } = sandbox()
  try {
    const owner = wrapperEntry(registryDir, 'module-nf-core-alpha', {
      files: { 'modules/nf-core/shared/tool/main.nf': 'alpha\n' }
    })
    const above = wrapperEntry(registryDir, 'module-nf-core-above', {
      files: { 'modules/nf-core/shared': 'above\n' }
    })
    const below = wrapperEntry(registryDir, 'module-nf-core-below', {
      files: { 'modules/nf-core/shared/tool/main.nf/extra.nf': 'below\n' }
    })
    const source = registry(registryDir, [owner, above, below])
    await installPackages(planInstall(source, { type: 'wrapper', id: owner.id }, { agentDir }), {
      agentDir
    })

    for (const entry of [above, below]) {
      await assert.rejects(
        installPackages(planInstall(source, { type: 'wrapper', id: entry.id }, { agentDir }), {
          agentDir
        }),
        /module-nf-core-alpha.*拥有/
      )
      assert.equal(readWrapperTreeState(agentDir).packages[entry.id], undefined)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('refuses duplicate wrapper ids declared at different owned paths', async () => {
  const { root, agentDir, registryDir } = sandbox()
  const manifest = (name: string): string => `id: acme/modules/duplicate
name: ${name}
summary: Duplicate id fixture.
params: {}
outputs:
  report:
    type: path
    path: results/report.txt
    primary: true
`
  try {
    const first = wrapperEntry(registryDir, 'module-acme-alpha', {
      files: { 'modules/acme/alpha/wrapper/wrapper.yaml': manifest('Alpha') }
    })
    const second = wrapperEntry(registryDir, 'module-acme-beta', {
      files: { 'modules/acme/beta/wrapper/wrapper.yaml': manifest('Beta') }
    })
    const source = registry(registryDir, [first, second])
    await assert.rejects(
      installPackages(
        {
          registry: source,
          root: { type: first.type, id: first.id, version: first.version },
          packages: [first, second].map((entry) => ({
            ...entry,
            installedBy: 'user' as const
          })),
          totalSize: first.size + second.size,
          environments: [],
          agentDir
        },
        { agentDir }
      ),
      /wrapper id 'acme\/modules\/duplicate'/
    )
    assert.deepEqual(readWrapperTreeState(agentDir).packages, {})
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('refuses an include whose owning wrapper package is not declared as a dependency', async () => {
  const { root, agentDir, registryDir } = sandbox()
  try {
    const modulePackage = wrapperEntry(registryDir, 'module-nf-core-alpha', {
      files: { 'modules/nf-core/alpha/main.nf': 'process ALPHA {}\n' }
    })
    const subworkflow = wrapperEntry(registryDir, 'subworkflow-local-demo', {
      files: {
        'subworkflows/local/demo/main.nf':
          "include { ALPHA } from '../../../modules/nf-core/alpha/main.nf'\nworkflow {}\n"
      }
    })
    const source = registry(registryDir, [modulePackage, subworkflow])
    await installPackages(
      planInstall(source, { type: 'wrapper', id: modulePackage.id }, { agentDir }),
      { agentDir }
    )

    await assert.rejects(
      installPackages(planInstall(source, { type: 'wrapper', id: subworkflow.id }, { agentDir }), {
        agentDir
      }),
      /module-nf-core-alpha.*dependsOn/
    )
    assert.equal(readWrapperTreeState(agentDir).packages[subworkflow.id], undefined)

    const declared = wrapperEntry(registryDir, 'subworkflow-local-declared', {
      dependsOn: [{ id: modulePackage.id, type: 'wrapper', version: '^1.0.0' }],
      files: {
        'subworkflows/local/declared/main.nf':
          "include { ALPHA } from '../../../modules/nf-core/alpha/main.nf'\nworkflow {}\n"
      }
    })
    const declaredSource = registry(registryDir, [modulePackage, declared])
    await installPackages(
      planInstall(declaredSource, { type: 'wrapper', id: declared.id }, { agentDir }),
      { agentDir }
    )
    assert.equal(readWrapperTreeState(agentDir).packages[declared.id]?.version, '1.0.0')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('refuses unresolved local includes', async () => {
  const { root, agentDir, registryDir } = sandbox()
  try {
    const missing = wrapperEntry(registryDir, 'subworkflow-local-missing', {
      files: {
        'subworkflows/local/missing/main.nf':
          "include { GONE } from '../../../modules/local/not_there'\nworkflow {}\n"
      }
    })
    const source = registry(registryDir, [missing])

    await assert.rejects(
      installPackages(planInstall(source, { type: 'wrapper', id: missing.id }, { agentDir }), {
        agentDir
      }),
      /cannot be resolved/
    )
    assert.equal(readWrapperTreeState(agentDir).packages[missing.id], undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('allows Nextflow plugin includes as external references', async () => {
  const { root, agentDir, registryDir } = sandbox()
  try {
    const entry = wrapperEntry(registryDir, 'subworkflow-local-plugin', {
      files: {
        'subworkflows/local/plugin/main.nf':
          "include { validateParameters } from 'plugin/nf-schema'\nworkflow {}\n"
      }
    })
    const source = registry(registryDir, [entry])
    await installPackages(planInstall(source, { type: 'wrapper', id: entry.id }, { agentDir }), {
      agentDir
    })
    assert.equal(readWrapperTreeState(agentDir).packages[entry.id]?.version, '1.0.0')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('batch validation sees dependency providers that appear later in the transaction', async () => {
  const { root, agentDir, registryDir } = sandbox()
  try {
    const consumer = wrapperEntry(registryDir, 'module-acme-consumer', {
      files: {
        'modules/acme/consumer/main.nf':
          "include { PROVIDER } from '../provider/main.nf'\nworkflow {}\n"
      }
    })
    const provider = wrapperEntry(registryDir, 'module-acme-provider', {
      files: { 'modules/acme/provider/main.nf': 'process PROVIDER {}\n' }
    })
    const source = registry(registryDir, [consumer, provider])

    await assert.rejects(
      installPackages(
        {
          registry: source,
          root: { type: consumer.type, id: consumer.id, version: consumer.version },
          packages: [consumer, provider].map((entry) => ({
            ...entry,
            installedBy: 'user' as const
          })),
          totalSize: consumer.size + provider.size,
          environments: [],
          agentDir
        },
        { agentDir }
      ),
      /module-acme-provider.*dependsOn/
    )
    assert.deepEqual(readWrapperTreeState(agentDir).packages, {})
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('batch commit publishes all wrapper stages or none', async () => {
  const { root, agentDir, registryDir } = sandbox()
  try {
    const dependency = wrapperEntry(registryDir, 'module-nf-core-alpha', {
      files: { 'modules/nf-core/alpha/main.nf': 'process ALPHA {}\n' }
    })
    const conflicting = wrapperEntry(registryDir, 'module-nf-core-conflicting', {
      dependsOn: [{ id: dependency.id, type: 'wrapper', version: '^1.0.0' }],
      files: {
        'modules/nf-core/alpha/main.nf': 'process CONFLICTING {}\n'
      }
    })
    const source = registry(registryDir, [dependency, conflicting])
    const plan = planInstall(source, { type: 'wrapper', id: conflicting.id }, { agentDir })
    assert.deepEqual(
      plan.packages.map((entry) => entry.id),
      [dependency.id, conflicting.id]
    )

    await assert.rejects(installPackages(plan, { agentDir }), /module-nf-core-alpha.*拥有/)
    assert.deepEqual(readWrapperTreeState(agentDir).packages, {})
    assert.equal(
      existsSync(join(agentDir, 'wrappers', 'tree', 'modules/nf-core/alpha/main.nf')),
      false
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('upgrades one wrapper package atomically and removes paths it no longer owns', async () => {
  const { root, agentDir, registryDir } = sandbox()
  try {
    const first = wrapperEntry(registryDir, 'module-nf-core-alpha', {
      version: '1.0.0',
      files: {
        'modules/nf-core/alpha/main.nf': 'v1\n',
        'modules/nf-core/alpha/removed.txt': 'remove me\n'
      }
    })
    const second = wrapperEntry(registryDir, 'module-nf-core-alpha', {
      version: '2.0.0',
      files: {
        'modules/nf-core/alpha/main.nf': 'v2\n',
        'modules/nf-core/alpha/added.txt': 'new\n'
      }
    })
    const source = registry(registryDir, [first, second])
    await installPackages(
      planInstall(source, { type: 'wrapper', id: first.id, version: first.version }, { agentDir }),
      { agentDir }
    )
    await upgradePackage(
      source,
      { type: 'wrapper', id: second.id, version: second.version },
      { agentDir }
    )

    const tree = join(agentDir, 'wrappers', 'tree')
    assert.equal(readFileSync(join(tree, 'modules/nf-core/alpha/main.nf'), 'utf8'), 'v2\n')
    assert.equal(existsSync(join(tree, 'modules/nf-core/alpha/removed.txt')), false)
    assert.equal(readFileSync(join(tree, 'modules/nf-core/alpha/added.txt'), 'utf8'), 'new\n')
    assert.equal(readWrapperTreeState(agentDir).packages[first.id]?.version, '2.0.0')
    assert.equal(listInstalledPackages({ agentDir })[0]?.version, '2.0.0')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a failed wrapper upgrade preserves the complete previous package', async () => {
  const { root, agentDir, registryDir } = sandbox()
  try {
    const first = wrapperEntry(registryDir, 'module-nf-core-alpha', {
      version: '1.0.0',
      files: { 'modules/nf-core/alpha/main.nf': 'v1\n' }
    })
    const second = wrapperEntry(registryDir, 'module-nf-core-alpha', {
      version: '2.0.0',
      files: {
        'modules/nf-core/alpha/main.nf': 'v2\n',
        'modules/nf-core/alpha/new.txt': 'new\n'
      }
    })
    const source = registry(registryDir, [first, second])
    await installPackages(
      planInstall(source, { type: 'wrapper', id: first.id, version: first.version }, { agentDir }),
      { agentDir }
    )
    const unowned = join(agentDir, 'wrappers', 'tree', 'modules/nf-core/alpha/new.txt')
    writeFileSync(unowned, 'user file\n')

    await assert.rejects(
      upgradePackage(
        source,
        { type: 'wrapper', id: second.id, version: second.version },
        { agentDir }
      ),
      /不受.*所有权/
    )
    assert.equal(
      readFileSync(join(agentDir, 'wrappers', 'tree', 'modules/nf-core/alpha/main.nf'), 'utf8'),
      'v1\n'
    )
    assert.equal(readFileSync(unowned, 'utf8'), 'user file\n')
    assert.equal(readWrapperTreeState(agentDir).packages[first.id]?.version, '1.0.0')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('uninstall removes only owned paths and empty directories, never custom wrappers', async () => {
  const { root, agentDir, registryDir } = sandbox()
  try {
    const custom = join(agentDir, 'wrappers', 'custom', 'mine', 'main.nf')
    mkdirSync(join(custom, '..'), { recursive: true })
    writeFileSync(custom, 'custom\n')
    const entry = wrapperEntry(registryDir, 'module-nf-core-alpha', {
      files: { 'modules/nf-core/alpha/main.nf': 'owned\n' }
    })
    const source = registry(registryDir, [entry])
    await installPackages(planInstall(source, { type: 'wrapper', id: entry.id }, { agentDir }), {
      agentDir
    })
    const unowned = join(agentDir, 'wrappers', 'tree', 'user-notes.txt')
    writeFileSync(unowned, 'keep\n')

    uninstallPackage('wrapper', entry.id, { agentDir })

    assert.equal(existsSync(join(agentDir, 'wrappers', 'tree', 'modules')), false)
    assert.equal(readFileSync(unowned, 'utf8'), 'keep\n')
    assert.equal(readFileSync(custom, 'utf8'), 'custom\n')
    assert.deepEqual(readWrapperTreeState(agentDir).packages, {})
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('reads a large ownership map quickly and still rejects nested ownership', async () => {
  const { root, agentDir, registryDir } = sandbox()
  try {
    const entry = wrapperEntry(registryDir, 'module-nf-core-seed', {
      files: { 'modules/nf-core/seed/main.nf': 'process SEED {}\n' }
    })
    await installPackages(
      planInstall(registry(registryDir, [entry]), { type: 'wrapper', id: entry.id }, { agentDir }),
      { agentDir }
    )
    const treePath = join(agentDir, 'wrappers', 'tree.json')
    const tree = JSON.parse(readFileSync(treePath, 'utf8')) as {
      packages: Record<string, Record<string, unknown>>
    }
    const seed = tree.packages[entry.id] as {
      manifest: Record<string, unknown>
      source: Record<string, unknown>
    }
    const clone = (id: string, paths: string[]): Record<string, unknown> => ({
      ...seed,
      manifest: { ...seed.manifest, id },
      source: { ...seed.source, id },
      paths
    })
    // About the size of the bundled tree: 200 packages owning 10 000 paths.
    for (let index = 0; index < 200; index += 1) {
      const id = `module-nf-core-tool${index}`
      tree.packages[id] = clone(
        id,
        Array.from(
          { length: 50 },
          (_, file) => `modules/nf-core/tool${index}/sub/file${file}.nf`
        ).sort()
      )
    }
    writeFileSync(treePath, JSON.stringify(tree))

    const started = performance.now()
    assert.equal(Object.keys(readWrapperTreeState(agentDir).packages).length, 201)
    assert.ok(performance.now() - started < 500, 'reading the ownership map must stay fast')

    tree.packages['module-nf-core-nested'] = clone('module-nf-core-nested', [
      'modules/nf-core/tool3/sub'
    ])
    writeFileSync(treePath, JSON.stringify(tree))
    assert.throws(() => readWrapperTreeState(agentDir), /conflict between/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
