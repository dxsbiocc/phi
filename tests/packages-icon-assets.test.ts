import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { stringify as stringifyYaml } from 'yaml'

import { buildRegistry, type RegistryIndexEntry } from '../scripts/packages/build-registry'
import { createDeterministicTarGz, parseTarGz } from '../src/main/agent/packages/archive'
import { installPackages, planInstall, readRegistry } from '../src/main/agent/packages/installer'
import { materializeWrapperRegistry } from '../src/main/agent/wrappers/packages/builder'
import { pluginVersionDir } from '../src/main/agent/plugins/store'

const roots: string[] = []
const icon = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3"/></svg>'
)

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), 'phi-package-icons-'))
  roots.push(root)
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  return root
}

function write(path: string, data: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, data)
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function skill(root: string, id = 'test-skill'): string {
  const dir = join(root, 'resources', 'skills', id)
  write(join(dir, 'SKILL.md'), `---\nname: ${id}\ndescription: A test skill.\n---\n# Test\n`)
  return dir
}

function packageSource(root: string, type: 'mcp' | 'plugin'): string {
  const dir = join(root, 'resources', type === 'mcp' ? 'connectors' : 'plugins', `test-${type}`)
  write(
    join(dir, 'phi-package.yaml'),
    stringifyYaml({
      schemaVersion: 1,
      id: `test-${type}`,
      type,
      version: '1.0.1',
      title: `Test ${type}`,
      summary: `Test ${type} package.`,
      ...(type === 'mcp'
        ? {
            connector: {
              transport: 'http',
              publisher: 'Phi',
              category: '科研数据',
              url: 'https://example.com/mcp',
              auth: 'none'
            }
          }
        : { toolPrefix: 'testplugin', components: { skills: ['skills/test-helper'] } })
    })
  )
  if (type === 'plugin') {
    write(
      join(dir, 'skills/test-helper/SKILL.md'),
      '---\nname: test-helper\ndescription: Plugin skill.\n---\n# Helper\n'
    )
  }
  return dir
}

function build(root: string): ReturnType<typeof buildRegistry> {
  execFileSync('git', ['add', 'resources'], { cwd: root })
  return buildRegistry({
    repoRoot: root,
    outDir: join(root, 'registry'),
    generatedAt: '2026-10-08T00:00:00Z'
  })
}

function verifyPublishedIcon(
  root: string,
  entry: RegistryIndexEntry,
  sourcePath: string,
  data: Buffer
): void {
  assert.ok(entry.iconAsset)
  assert.deepEqual(entry.iconAsset, {
    path: `icons/${entry.type}-${entry.id}-${entry.version}${sourcePath.slice(sourcePath.lastIndexOf('.'))}`,
    sha256: sha256(data),
    size: data.length
  })
  assert.deepEqual(readFileSync(join(root, 'registry', entry.iconAsset.path)), data)
  const entries = parseTarGz(readFileSync(join(root, 'registry', entry.archive)))
  assert.deepEqual(entries.find((file) => file.path === sourcePath)?.data, data)
  const filesDocument = entries.find((file) => file.path === 'files.json')
  assert.ok(filesDocument)
  const listed = JSON.parse(filesDocument.data.toString('utf8')) as {
    files: Array<{ path: string; size: number; sha256: string }>
  }
  assert.deepEqual(
    listed.files.find((file) => file.path === sourcePath),
    { path: sourcePath, sha256: sha256(data), size: data.length }
  )
}

test('publishes exact sidecars and archive allowlist entries for skills, MCPs, and plugins', () => {
  const root = sandbox()
  for (const dir of [skill(root), packageSource(root, 'mcp'), packageSource(root, 'plugin')]) {
    write(join(dir, 'icon.svg'), icon)
  }
  const index = build(root)
  assert.equal(index.packages.length, 3)
  for (const entry of index.packages) verifyPublishedIcon(root, entry, 'icon.svg', icon)
  assert.deepEqual(readRegistry(join(root, 'registry')).packages, index.packages)
})

test('installed plugins retain all default root icon files after their source is removed', async () => {
  const root = sandbox()
  const source = packageSource(root, 'plugin')
  const icons = ['icon.svg', 'icon.png', 'icon.webp', 'icon.jpg', 'icon.jpeg']
  for (const filename of icons) write(join(source, filename), icon)
  const entry = build(root).packages[0]
  const agentDir = join(root, 'plugin-agent')
  const registry = readRegistry(join(root, 'registry'))
  await installPackages(planInstall(registry, { type: 'plugin', id: entry.id }, { agentDir }), {
    agentDir
  })
  rmSync(source, { recursive: true, force: true })
  rmSync(join(root, 'registry'), { recursive: true, force: true })
  const installedDir = pluginVersionDir(entry.id, entry.version, agentDir)
  for (const filename of icons) assert.deepEqual(readFileSync(join(installedDir, filename)), icon)
  assert.equal(sha256(readFileSync(join(installedDir, 'icon.svg'))), entry.iconAsset?.sha256)
})

test('uses documented extension priority at the package root and ignores nested icons', () => {
  const root = sandbox()
  const dir = skill(root)
  write(join(dir, 'icon.svg'), icon)
  write(join(dir, 'icon.png'), Buffer.from('different raster bytes'))
  write(join(dir, 'references/icon.svg'), Buffer.from('nested image'))
  const fallback = skill(root, 'fallback-skill')
  write(join(fallback, 'references/icon.svg'), icon)
  const index = build(root)
  const preferred = index.packages.find((entry) => entry.id === 'test-skill')
  assert.ok(preferred)
  verifyPublishedIcon(root, preferred, 'icon.svg', icon)
  assert.equal(index.packages.find((entry) => entry.id === 'fallback-skill')?.iconAsset, undefined)
})

test('publishes every supported default image extension', () => {
  for (const extension of ['svg', 'png', 'webp', 'jpg', 'jpeg']) {
    const root = sandbox()
    write(join(skill(root), `icon.${extension}`), icon)
    const entry = build(root).packages[0]
    verifyPublishedIcon(root, entry, `icon.${extension}`, icon)
  }
})

function wrapper(root: string, path: string, id: string): string {
  const dir = join(root, 'resources', 'wrappers', path)
  write(join(dir, 'main.nf'), 'process RUN {}\n')
  write(
    join(dir, 'wrapper/wrapper.yaml'),
    stringifyYaml({
      id,
      name: id,
      summary: 'Wrapper fixture.',
      params: { outdir: { kind: 'output', type: 'path', required: true } },
      outputs: { results: { type: 'directory', path: '${outdir}', primary: true } }
    })
  )
  write(join(dir, 'wrapper/main.nf'), "include { RUN } from '../main.nf'\n")
  write(join(dir, 'wrapper/params.json'), '{}\n')
  return dir
}

test('wrapper registries select a family root before its adapter and ignore arbitrary leaf icons', async () => {
  const root = sandbox()
  const leaf = wrapper(root, 'modules/nf-core/alpha/run', 'nf-core/modules/alpha-run')
  write(join(leaf, 'wrapper/icon.svg'), icon)
  write(join(root, 'resources/wrappers/modules/nf-core/alpha/icon.png'), icon)
  const nestedOnly = wrapper(root, 'modules/nf-core/beta/run', 'nf-core/modules/beta-run')
  write(join(nestedOnly, 'icon.svg'), icon)
  const workflow = wrapper(root, 'workflows/demo', 'local/workflows/demo')
  write(join(workflow, 'wrapper/icon.svg'), icon)
  const index = build(root)
  const family = index.packages.find((entry) => entry.id === 'module-nf-core-alpha')
  const workflowEntry = index.packages.find((entry) => entry.id === 'workflow-local-demo')
  assert.ok(family)
  assert.ok(workflowEntry)
  verifyPublishedIcon(root, family, 'modules/nf-core/alpha/icon.png', icon)
  verifyPublishedIcon(root, workflowEntry, 'workflows/demo/wrapper/icon.svg', icon)
  assert.equal(
    index.packages.find((entry) => entry.id === 'module-nf-core-beta')?.iconAsset,
    undefined
  )

  const runtime = materializeWrapperRegistry({
    wrappersRoot: join(root, 'resources/wrappers'),
    outDir: join(root, 'runtime-registry')
  })
  assert.deepEqual(
    runtime.index.packages.find((entry) => entry.id === family.id)?.iconAsset,
    family.iconAsset
  )
  const agentDir = join(root, 'wrapper-agent')
  const plan = planInstall(
    readRegistry(join(root, 'registry')),
    { type: 'wrapper', id: family.id },
    { agentDir }
  )
  await installPackages(plan, { agentDir })
  assert.deepEqual(
    readFileSync(join(agentDir, 'wrappers/tree/modules/nf-core/alpha/icon.png')),
    icon
  )
})

test('registry readers retain valid metadata, accept legacy entries, and reject unsafe descriptors', () => {
  const root = sandbox()
  skill(root)
  const entry = build(root).packages[0]
  const valid = { path: 'icons/example.svg', sha256: sha256(icon), size: icon.length }
  const registryDir = join(root, 'registry')
  const readWith = (iconAsset: unknown): ReturnType<typeof readRegistry> => {
    write(
      join(registryDir, 'index.json'),
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-10-08T00:00:00Z',
        packages: [{ ...entry, ...(iconAsset === undefined ? {} : { iconAsset }) }]
      })
    )
    return readRegistry(registryDir)
  }
  assert.equal(readWith(undefined).packages[0].iconAsset, undefined)
  assert.deepEqual(readWith(valid).packages[0].iconAsset, valid)
  for (const path of [
    '/icon.svg',
    '../icon.svg',
    'icons/../icon.svg',
    'icons//icon.svg',
    './icon.svg',
    'C:/icon.svg',
    'icons\\icon.svg',
    'https://example.com/icon.svg',
    'icons/icon.svg?x',
    'icons/%2e%2e/icon.svg',
    'icons/icon.html',
    'icons/icon.svg\0'
  ]) {
    assert.throws(() => readWith({ ...valid, path }), /iconAsset/, path)
  }
  for (const value of [
    null,
    [],
    {},
    { ...valid, sha256: 'a'.repeat(63) },
    { ...valid, sha256: 'Z'.repeat(64) },
    { ...valid, size: 0 },
    { ...valid, size: -1 },
    { ...valid, size: 1.5 },
    { ...valid, size: 256 * 1024 + 1 }
  ]) {
    assert.throws(() => readWith(value), /iconAsset/)
  }
})

test('builder refuses empty and oversized default icon files', () => {
  for (const size of [0, 256 * 1024 + 1]) {
    const root = sandbox()
    write(join(skill(root), 'icon.png'), Buffer.alloc(size))
    assert.throws(() => build(root), /package icon.*must contain/)
  }
})

test('installation preserves the verified icon and rejects a payload changed after files.json generation', async () => {
  const root = sandbox()
  const source = packageSource(root, 'mcp')
  write(join(source, 'icon.svg'), icon)
  const entry = build(root).packages[0]
  const registryDir = join(root, 'registry')
  const registry = readRegistry(registryDir)
  const agentDir = join(root, 'agent')
  const plan = planInstall(registry, { type: 'mcp', id: entry.id }, { agentDir })
  await installPackages(plan, { agentDir })
  const installedDir = join(agentDir, 'packages/mcp', entry.id, entry.version)
  assert.deepEqual(readFileSync(join(installedDir, 'icon.svg')), icon)
  assert.equal(sha256(readFileSync(join(installedDir, 'icon.svg'))), entry.iconAsset?.sha256)
  assert.ok(existsSync(join(installedDir, 'files.json')))

  const archive = parseTarGz(readFileSync(join(registryDir, entry.archive)))
  const corrupted = createDeterministicTarGz(
    archive
      .filter((file) => file.type === 'file')
      .map((file) => ({
        path: file.path,
        data: file.path === 'icon.svg' ? Buffer.from('tampered icon') : file.data
      }))
  )
  write(join(registryDir, entry.archive), corrupted)
  write(
    join(registryDir, 'index.json'),
    JSON.stringify({
      ...registry,
      packages: [{ ...entry, sha256: sha256(corrupted), size: corrupted.length }]
    })
  )
  const rejectedAgentDir = join(root, 'rejected-agent')
  const corruptPlan = planInstall(
    readRegistry(registryDir),
    { type: 'mcp', id: entry.id },
    { agentDir: rejectedAgentDir }
  )
  await assert.rejects(installPackages(corruptPlan, { agentDir: rejectedAgentDir }), /icon\.svg/)
  assert.equal(existsSync(join(rejectedAgentDir, 'packages/mcp', entry.id, entry.version)), false)
})

test('migrated connector payloads retain original logo hashes and patch versions', () => {
  const attribution = readFileSync(join(process.cwd(), 'docs/content-icons.md'), 'utf8')
  const records = [
    ...attribution.matchAll(
      /`(resources\/connectors\/[^`]+)`\s*\|\s*`([a-f0-9]{64})`\s*\|\s*(\d+)/g
    )
  ]
  assert.equal(records.length, 18)
  for (const [, path, hash, size] of records) {
    const data = readFileSync(join(process.cwd(), path))
    assert.equal(sha256(data), hash, path)
    assert.equal(data.length, Number(size), path)
    const manifest = readFileSync(join(process.cwd(), dirname(path), 'phi-package.yaml'), 'utf8')
    assert.match(manifest, /^version: 1\.0\.1$/m, path)
  }
})
