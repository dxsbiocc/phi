import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import {
  buildRegistry,
  buildRegistryWithReport,
  type RegistryIndex,
  type RegistryIndexEntry
} from '../scripts/packages/build-registry'
import { parseTarGz, type TarEntry } from '../src/main/agent/packages/archive'
import { materializeWrapperRegistry } from '../src/main/agent/wrappers/packages/builder'

const roots: string[] = []

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function temporaryRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'phi-package-builder-'))
  roots.push(root)
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  return root
}

function write(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function writeSkill(
  root: string,
  options: {
    name?: string
    description?: string
    metadataVersion?: string
  } = {}
): string {
  const name = options.name ?? 'alpha-skill'
  const description = options.description ?? 'Alpha skill fixture.'
  const dir = join(root, 'resources', 'skills', name)
  const frontmatter = {
    name,
    description,
    phi: { environment: 'phi:python@1' },
    ...(options.metadataVersion
      ? { metadata: { version: options.metadataVersion, author: 'Phi tests' } }
      : {})
  }
  write(join(dir, 'SKILL.md'), `---\n${stringifyYaml(frontmatter)}---\n\n# ${name}\n`)
  write(join(dir, 'scripts', 'run.py'), `print(${JSON.stringify(name)})\n`)
  return dir
}

function writePlugin(root: string): string {
  const dir = join(root, 'resources', 'plugins', 'demo-plugin')
  write(
    join(dir, 'phi-package.yaml'),
    stringifyYaml({
      schemaVersion: 1,
      id: 'demo-plugin',
      type: 'plugin',
      version: '1.4.0',
      title: 'Demo plugin',
      summary: 'Plugin fixture for the local registry.',
      minAppVersion: '0.9.0',
      requires: { coreTools: ['skill_run', 'env_request'] },
      dependsOn: [{ id: 'alpha-skill', type: 'skill', version: '^2.0.0' }],
      toolPrefix: 'demo',
      components: { skills: ['skills/demo-helper'] }
    })
  )
  write(
    join(dir, 'skills', 'demo-helper', 'SKILL.md'),
    `---
name: demo-helper
description: Skill nested in the demo plugin.
---

# Demo helper
`
  )
  return dir
}

function writeConnector(root: string): string {
  const dir = join(root, 'resources', 'connectors', 'demo-connector')
  write(
    join(dir, 'phi-package.yaml'),
    stringifyYaml({
      schemaVersion: 1,
      id: 'demo-connector',
      type: 'mcp',
      version: '1.0.0',
      title: 'Demo connector',
      summary: 'Connector fixture for the local registry.',
      connector: {
        transport: 'http',
        publisher: 'Phi',
        category: '科研数据',
        homepage: 'https://example.com/demo',
        url: 'https://example.com/mcp',
        auth: 'none'
      }
    })
  )
  return dir
}

function trackResources(root: string): void {
  execFileSync('git', ['add', 'resources'], { cwd: root })
}

function build(root: string, outName = 'registry'): RegistryIndex {
  return buildRegistry({
    repoRoot: root,
    outDir: join(root, outName),
    generatedAt: '2026-10-02T00:00:00.000Z'
  })
}

function registryEntry(
  index: RegistryIndex,
  type: 'skill' | 'plugin' | 'wrapper' | 'mcp',
  id: string
): RegistryIndexEntry {
  const entry = index.packages.find((candidate) => candidate.type === type && candidate.id === id)
  assert.ok(entry, `missing ${type}:${id} registry entry`)
  return entry
}

function writeWrapperAdapter(
  componentDir: string,
  id: string,
  options: { name?: string; summary?: string } = {}
): void {
  write(
    join(componentDir, 'wrapper', 'wrapper.yaml'),
    stringifyYaml({
      id,
      name: options.name ?? id,
      summary: options.summary ?? `Fixture adapter for ${id}.`,
      params: {
        outdir: { kind: 'output', type: 'path', required: true }
      },
      outputs: {
        results: { type: 'directory', path: '${outdir}', primary: true }
      }
    })
  )
  write(join(componentDir, 'wrapper', 'main.nf'), `include { RUN } from '../main.nf'\n`)
  write(join(componentDir, 'wrapper', 'params.json'), '{}\n')
}

function writeModule(
  root: string,
  provider: string,
  family: string,
  component: string,
  main = 'process RUN {}\n'
): string {
  const dir = join(root, 'resources', 'wrappers', 'modules', provider, family, component)
  write(join(dir, 'main.nf'), main)
  writeWrapperAdapter(
    dir,
    `${provider}/modules/${family.replaceAll('/', '-')}-${component}`.replaceAll('_', '-')
  )
  return dir
}

function writeSubworkflow(root: string, provider: string, name: string, main: string): string {
  const dir = join(root, 'resources', 'wrappers', 'subworkflows', provider, name)
  write(join(dir, 'main.nf'), main)
  writeWrapperAdapter(dir, `${provider}/subworkflows/${name.replaceAll('_', '-')}`)
  return dir
}

function writeWorkflow(root: string, provider: string, name: string): string {
  const dir = join(root, 'resources', 'wrappers', 'workflows', provider, name)
  write(join(dir, 'main.nf'), 'workflow RUN {}\n')
  writeWrapperAdapter(dir, `${provider}/workflows/${name}`, {
    name: `${name} workflow`,
    summary: `${name} workflow fixture.`
  })
  return dir
}

function archiveEntries(root: string, outName: string, entry: RegistryIndexEntry): TarEntry[] {
  return parseTarGz(readFileSync(join(root, outName, entry.archive)))
}

function archiveFile(entries: TarEntry[], path: string): Buffer {
  const entry = entries.find((candidate) => candidate.path === path)
  assert.ok(entry, `missing archive entry ${path}`)
  assert.equal(entry.type, 'file')
  return entry.data
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

test('generates a skill manifest and exact files.json from tracked files only', () => {
  const root = temporaryRepository()
  const description = 'D'.repeat(340)
  const skillDir = writeSkill(root, {
    description,
    metadataVersion: '2.3.4'
  })
  trackResources(root)
  // check-resources deliberately permits this untracked macOS file, but it must not ship.
  write(join(skillDir, '.DS_Store'), 'untracked noise\n')

  const index = build(root)
  const entry = registryEntry(index, 'skill', 'alpha-skill')
  const entries = archiveEntries(root, 'registry', entry)

  assert.deepEqual(
    entries.map((item) => item.path),
    ['SKILL.md', 'files.json', 'phi-package.yaml', 'scripts/run.py']
  )
  const manifest = parseYaml(archiveFile(entries, 'phi-package.yaml').toString('utf8')) as Record<
    string,
    unknown
  >
  assert.deepEqual(manifest, {
    schemaVersion: 1,
    id: 'alpha-skill',
    type: 'skill',
    version: '2.3.4',
    title: 'alpha-skill',
    summary: description.slice(0, 300),
    files: 'files.json'
  })

  const filesDocument = JSON.parse(archiveFile(entries, 'files.json').toString('utf8')) as {
    version: number
    files: Array<{ path: string; sha256: string; size: number }>
  }
  assert.equal(filesDocument.version, 1)
  assert.deepEqual(
    filesDocument.files.map((file) => file.path),
    ['SKILL.md', 'phi-package.yaml', 'scripts/run.py']
  )
  for (const listed of filesDocument.files) {
    const data = archiveFile(entries, listed.path)
    assert.equal(listed.size, data.length, listed.path)
    assert.equal(listed.sha256, sha256(data), listed.path)
  }
  assert.equal(
    filesDocument.files.some((file) => file.path === 'files.json'),
    false
  )
  assert.equal(
    entries.some((item) => item.path === '.DS_Store'),
    false
  )
})

test('falls back to version 1.0.0 when skill metadata.version is not semver', () => {
  const root = temporaryRepository()
  writeSkill(root, { name: 'fallback-skill', metadataVersion: '1.3' })
  trackResources(root)

  const index = build(root)
  const entry = registryEntry(index, 'skill', 'fallback-skill')
  const manifest = parseYaml(
    archiveFile(archiveEntries(root, 'registry', entry), 'phi-package.yaml').toString('utf8')
  ) as Record<string, unknown>

  assert.equal(entry.version, '1.0.0')
  assert.equal(manifest.version, '1.0.0')
})

test('round-trips tracked paths longer than the legacy tar name field', () => {
  const root = temporaryRepository()
  const skillDir = writeSkill(root)
  const longPath = `references/${'nested/'.repeat(14)}guide.md`
  assert(Buffer.byteLength(longPath) > 100)
  write(join(skillDir, longPath), '# Long path\n')
  trackResources(root)

  const index = build(root)
  const entry = registryEntry(index, 'skill', 'alpha-skill')
  assert(archiveEntries(root, 'registry', entry).some((item) => item.path === longPath))
})

test('rejects an ordinary untracked file under resources', () => {
  const root = temporaryRepository()
  const skillDir = writeSkill(root)
  trackResources(root)
  write(join(skillDir, 'notes.tmp'), 'not tracked\n')

  assert.throws(
    () => build(root),
    /untracked files under resources are not allowed: resources\/skills\/alpha-skill\/notes\.tmp/
  )
})

test('rejects every tracked run-leftover category', async (context) => {
  const leftovers = [
    '.nextflow/cache',
    '.nextflow.log',
    'work/run.txt',
    'results/result.txt',
    'scripts/__pycache__/cache.pyc',
    '.DS_Store'
  ]

  for (const relativePath of leftovers) {
    await context.test(relativePath, () => {
      const root = temporaryRepository()
      const skillDir = writeSkill(root)
      write(join(skillDir, relativePath), 'leftover\n')
      trackResources(root)

      assert.throws(
        () => build(root),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes('run leftover is not allowed') &&
          error.message.includes(relativePath)
      )
    })
  }
})

test('produces byte-identical archives and digests across builds', () => {
  const root = temporaryRepository()
  writeSkill(root, { metadataVersion: '2.3.4' })
  writePlugin(root)
  trackResources(root)

  const first = build(root, 'registry-one')
  const second = build(root, 'registry-two')

  assert.deepEqual(first, second)
  for (const firstEntry of first.packages) {
    const secondEntry = registryEntry(second, firstEntry.type, firstEntry.id)
    const firstArchive = readFileSync(join(root, 'registry-one', firstEntry.archive))
    const secondArchive = readFileSync(join(root, 'registry-two', secondEntry.archive))
    assert.deepEqual(firstArchive, secondArchive, firstEntry.archive)
    assert.equal(firstEntry.sha256, secondEntry.sha256)
    assert.equal(firstEntry.sha256, sha256(firstArchive))
    assert.equal(firstEntry.size, firstArchive.length)
  }
  assert.deepEqual(
    readFileSync(join(root, 'registry-one', 'index.json')),
    readFileSync(join(root, 'registry-two', 'index.json'))
  )
})

test('writes sorted registry entries with required and propagated index fields', () => {
  const root = temporaryRepository()
  writeSkill(root, { metadataVersion: '2.3.4' })
  writePlugin(root)
  trackResources(root)

  const index = build(root)
  const plugin = registryEntry(index, 'plugin', 'demo-plugin')
  const skill = registryEntry(index, 'skill', 'alpha-skill')

  assert.equal(index.schemaVersion, 1)
  assert.equal(index.generatedAt, '2026-10-02T00:00:00.000Z')
  assert.deepEqual(
    index.packages.map((entry) => `${entry.type}:${entry.id}@${entry.version}`),
    ['plugin:demo-plugin@1.4.0', 'skill:alpha-skill@2.3.4']
  )
  assert.deepEqual(
    {
      id: plugin.id,
      type: plugin.type,
      version: plugin.version,
      title: plugin.title,
      summary: plugin.summary,
      archive: plugin.archive,
      minAppVersion: plugin.minAppVersion,
      dependsOn: plugin.dependsOn,
      requires: plugin.requires
    },
    {
      id: 'demo-plugin',
      type: 'plugin',
      version: '1.4.0',
      title: 'Demo plugin',
      summary: 'Plugin fixture for the local registry.',
      archive: 'plugin-demo-plugin-1.4.0.tar.gz',
      minAppVersion: '0.9.0',
      dependsOn: [{ id: 'alpha-skill', type: 'skill', version: '^2.0.0' }],
      requires: { coreTools: ['skill_run', 'env_request'] }
    }
  )
  assert.deepEqual(skill.dependsOn, [])
  assert.equal(skill.archive, 'skill-alpha-skill-2.3.4.tar.gz')
  for (const entry of index.packages) {
    const archive = readFileSync(join(root, 'registry', entry.archive))
    assert.match(entry.sha256, /^[0-9a-f]{64}$/)
    assert.equal(entry.sha256, sha256(archive))
    assert.equal(entry.size, archive.length)
  }

  const published = JSON.parse(readFileSync(join(root, 'registry', 'index.json'), 'utf8'))
  assert.deepEqual(published, index)
})

test('packages individual modules and emits subworkflow and workflow tree packages', () => {
  const root = temporaryRepository()
  writeModule(root, 'nf-core', 'samtools', 'sort')
  writeModule(root, 'nf-core', 'samtools', 'index')
  writeModule(root, 'nf-core', 'bcftools', 'query')
  const local = writeModule(
    root,
    'local',
    'differential_expression',
    'deseq2',
    `process RUN { conda "\${moduleDir}/../../../../../images/differential-expression-r/environment.yml" }\n`
  )
  write(join(local, 'environment.yml'), 'name: deseq2\n')
  write(
    join(root, 'resources', 'wrappers', 'images', 'differential-expression-r', 'environment.yml'),
    'name: shared-r\n'
  )
  writeSubworkflow(root, 'nf-core', 'bam_sort', 'workflow RUN {}\n')
  writeWorkflow(root, 'nf-core', 'rnaseq')
  write(join(root, 'resources', 'wrappers', '.nf-core.yml'), 'repository_type: modules\n')
  trackResources(root)

  const { index, report } = buildRegistryWithReport({
    repoRoot: root,
    outDir: join(root, 'registry'),
    generatedAt: '2026-10-02T00:00:00.000Z'
  })

  assert.deepEqual(
    index.packages.map((entry) => `${entry.type}:${entry.id}`),
    [
      'wrapper:module-local-differential-expression-deseq2',
      'wrapper:module-nf-core-bcftools-query',
      'wrapper:module-nf-core-samtools-index',
      'wrapper:module-nf-core-samtools-sort',
      'wrapper:subworkflow-nf-core-bam-sort',
      'wrapper:workflow-nf-core-rnaseq'
    ]
  )
  assert.deepEqual(report.wrapperCountsByKind, {
    module: 4,
    subworkflow: 1,
    workflow: 1,
    support: 0
  })
  assert.deepEqual(report.unattributedSupportFiles, ['.nf-core.yml'])

  const samtoolsSort = archiveEntries(
    root,
    'registry',
    registryEntry(index, 'wrapper', 'module-nf-core-samtools-sort')
  ).map((entry) => entry.path)
  assert.ok(samtoolsSort.includes('modules/nf-core/samtools/sort/main.nf'))
  assert.ok(!samtoolsSort.includes('modules/nf-core/samtools/index/main.nf'))
  const differentialExpression = archiveEntries(
    root,
    'registry',
    registryEntry(index, 'wrapper', 'module-local-differential-expression-deseq2')
  ).map((entry) => entry.path)
  assert.ok(
    differentialExpression.includes('images/differential-expression-r/environment.yml'),
    'support used by one package belongs to that package'
  )
})

test('installing one module package does not include sibling wrappers', () => {
  const root = temporaryRepository()
  writeModule(root, 'nf-core', 'samtools', 'sort')
  writeModule(root, 'nf-core', 'samtools', 'index')
  trackResources(root)

  const index = build(root)
  const modules = index.packages.filter(
    (entry) => entry.type === 'wrapper' && entry.id.startsWith('module-nf-core-samtools')
  )
  assert.equal(modules.length, 2)
  for (const entry of modules) {
    const adapters = archiveEntries(root, 'registry', entry).filter((file) =>
      file.path.endsWith('/wrapper/wrapper.yaml')
    )
    assert.equal(adapters.length, 1, `${entry.id} should install exactly one wrapper`)
  }
})

test('packages nested module adapters without including sibling modules or family files', () => {
  const root = temporaryRepository()
  const family = join(root, 'resources', 'wrappers', 'modules', 'local', 'expression')
  writeModule(root, 'local', 'expression/visualization', 'volcano')
  writeModule(root, 'local', 'expression/visualization', 'pca')
  write(join(family, 'README.md'), 'Documentation for the module family.\n')
  trackResources(root)

  const index = build(root)
  const volcano = registryEntry(index, 'wrapper', 'module-local-expression-visualization-volcano')
  const paths = archiveEntries(root, 'registry', volcano).map((entry) => entry.path)
  assert.ok(paths.includes('modules/local/expression/visualization/volcano/main.nf'))
  assert.ok(!paths.includes('modules/local/expression/visualization/pca/main.nf'))
  assert.ok(!paths.includes('modules/local/expression/README.md'))
})

test('rejects duplicate wrapper ids across package paths', () => {
  const root = temporaryRepository()
  const first = writeModule(root, 'nf-core', 'alpha', 'run')
  const second = writeModule(root, 'nf-core', 'beta', 'run')
  writeWrapperAdapter(first, 'nf-core/modules/duplicate')
  writeWrapperAdapter(second, 'nf-core/modules/duplicate')
  trackResources(root)

  assert.throws(() => build(root), /duplicate wrapper id 'nf-core\/modules\/duplicate'/)
})

test('creates a support package only when distinct packages reference the same support files', () => {
  const root = temporaryRepository()
  writeModule(
    root,
    'local',
    'alpha',
    'run',
    `process RUN { conda "\${moduleDir}/../../../../../images/shared-r/environment.yml" }\n`
  )
  writeModule(
    root,
    'local',
    'beta',
    'run',
    `process RUN { conda "\${moduleDir}/../../../../../images/shared-r/environment.yml" }\n`
  )
  write(
    join(root, 'resources', 'wrappers', 'images', 'shared-r', 'environment.yml'),
    'name: shared-r\n'
  )
  trackResources(root)

  const index = build(root)
  const support = registryEntry(index, 'wrapper', 'support-local-shared-r')
  assert.deepEqual(
    archiveEntries(root, 'registry', support).map((entry) => entry.path),
    ['files.json', 'images/shared-r/environment.yml', 'phi-package.yaml']
  )
  for (const id of ['module-local-alpha-run', 'module-local-beta-run']) {
    assert.deepEqual(registryEntry(index, 'wrapper', id).dependsOn, [
      { id: 'support-local-shared-r', type: 'wrapper', version: '^1.0.0' }
    ])
  }
})

test('materializes a wrapper-only registry from a shipped filesystem tree without git', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-wrapper-runtime-builder-'))
  roots.push(root)
  writeModule(root, 'nf-core', 'fastqc', 'run')
  const wrappersRoot = join(root, 'resources', 'wrappers')
  const outDir = join(root, 'registry')

  const result = materializeWrapperRegistry({
    wrappersRoot,
    outDir,
    generatedAt: '2026-10-02T00:00:00.000Z'
  })

  assert.deepEqual(
    result.index.packages.map((entry) => `${entry.type}:${entry.id}`),
    ['wrapper:module-nf-core-fastqc-run']
  )
  assert.deepEqual(JSON.parse(readFileSync(join(outDir, 'index.json'), 'utf8')), result.index)
  assert.ok(readFileSync(join(outDir, result.index.packages[0].archive)).length > 0)
})

test('computes deterministic wrapper dependencies from recursive includes and reports misses', () => {
  const root = temporaryRepository()
  writeModule(root, 'nf-core', 'bwa', 'mem')
  writeModule(root, 'nf-core', 'samtools', 'view')
  writeSubworkflow(
    root,
    'nf-core',
    'align_reads',
    `include { BWA } from '../../../modules/nf-core/bwa/mem/main'\nworkflow RUN {}\n`
  )
  writeSubworkflow(
    root,
    'nf-core',
    'alignment_pipeline',
    `include { ALIGN } from '../align_reads/main'\ninclude { VIEW } from '../../../modules/nf-core/samtools/view/main'\ninclude { schema } from 'plugin/nf-schema'\nworkflow RUN {}\n`
  )
  trackResources(root)

  const first = buildRegistryWithReport({
    repoRoot: root,
    outDir: join(root, 'registry-one'),
    generatedAt: '2026-10-02T00:00:00.000Z'
  })
  const second = buildRegistryWithReport({
    repoRoot: root,
    outDir: join(root, 'registry-two'),
    generatedAt: '2026-10-02T00:00:00.000Z'
  })
  const pipeline = registryEntry(first.index, 'wrapper', 'subworkflow-nf-core-alignment-pipeline')
  assert.deepEqual(pipeline.dependsOn, [
    { id: 'module-nf-core-bwa-mem', type: 'wrapper', version: '^1.0.0' },
    { id: 'module-nf-core-samtools-view', type: 'wrapper', version: '^1.0.0' },
    { id: 'subworkflow-nf-core-align-reads', type: 'wrapper', version: '^1.0.0' }
  ])
  assert.ok(
    first.report.unattributedIncludes.some(
      (include) =>
        include.packageId === 'subworkflow-nf-core-alignment-pipeline' &&
        include.target === 'plugin/nf-schema' &&
        include.reason === 'not-found'
    )
  )
  assert.deepEqual(first, second)
  for (const entry of first.index.packages) {
    assert.deepEqual(
      readFileSync(join(root, 'registry-one', entry.archive)),
      readFileSync(join(root, 'registry-two', entry.archive)),
      entry.archive
    )
  }
})

test('packs tracked connector manifests as mcp packages', () => {
  const root = temporaryRepository()
  writeConnector(root)
  trackResources(root)

  const index = build(root)
  const entry = registryEntry(index, 'mcp', 'demo-connector')
  assert.equal(entry.type, 'mcp')
  assert.deepEqual(
    archiveEntries(root, 'registry', entry).map((item) => item.path),
    ['files.json', 'phi-package.yaml']
  )
})

test('an untracked connector is not packaged', () => {
  const root = temporaryRepository()
  writeConnector(root)
  assert.throws(() => build(root), /untracked|leftover|not tracked/i)
})
