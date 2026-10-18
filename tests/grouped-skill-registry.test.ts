import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { stringify } from 'yaml'

import { buildRegistry } from '../scripts/packages/build-registry'
import { parseTarGz } from '../src/main/agent/packages/archive'
import { installPackages } from '../src/main/agent/packages/installer'
import { planInstall } from '../src/main/agent/packages/planning'
import { readRegistry } from '../src/main/agent/packages/registry'
import {
  filterSkillCatalogItems,
  knownSkillCatalogPackages,
  skillCatalogGroups,
  skillCatalogItems
} from '../src/renderer/src/features/skill/lib/skillCatalogBrowser'

const roots: string[] = []
test.after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })))

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'phi-grouped-skills-'))
  roots.push(root)
  mkdirSync(join(root, 'resources/plugins'), { recursive: true })
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  return root
}

function write(root: string, path: string, content: string): void {
  const target = join(root, 'resources/skills', path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
}

function skill(root: string, path: string, category?: string): void {
  const name = path.split('/').at(-1)!
  write(
    root,
    `${path}/SKILL.md`,
    `---\n${stringify({
      name,
      description: `Grouped ${name} fixture`,
      metadata: { version: '1.3.0', ...(category ? { category } : {}) },
      phi: { environment: 'phi:python@1' }
    })}---\n# ${name}\n`
  )
  write(root, `${path}/scripts/helper.py`, 'print("complete resource")\n')
}

function build(root: string): ReturnType<typeof buildRegistry> {
  execFileSync('git', ['add', 'resources'], { cwd: root })
  return buildRegistry({
    repoRoot: root,
    outDir: join(root, 'registry'),
    generatedAt: '2026-10-17T04:00:00.000Z'
  })
}

test('grouped skills build, install and browse by their official directory groups', async () => {
  const root = fixture()
  skill(root, 'biology/single-cell/scanpy')
  skill(root, 'biology/pysam')
  skill(root, 'find-skills')
  write(root, 'biology/README.md', 'Group documentation, not a skill.\n')
  write(root, 'biology/single-cell/scanpy/references/example/SKILL.md', 'Bundled example.\n')
  const index = build(root)
  assert.deepEqual(
    index.packages.map((entry) => entry.id),
    ['find-skills', 'pysam', 'scanpy']
  )
  const scanpy = index.packages.find((entry) => entry.id === 'scanpy')!
  assert.equal(scanpy.category, 'biology/single-cell')
  const archived = parseTarGz(readFileSync(join(root, 'registry', scanpy.archive)))
  assert.ok(archived.some((entry) => entry.path === 'references/example/SKILL.md'))
  assert.ok(archived.some((entry) => entry.path === 'scripts/helper.py'))
  assert.ok(
    archived.every((entry) => !entry.path.includes('pysam') && !entry.path.includes('biology/'))
  )
  const registry = readRegistry(join(root, 'registry'))
  const agentDir = join(root, 'agent')
  await installPackages(planInstall(registry, { type: 'skill', id: 'scanpy' }, { agentDir }), {
    agentDir
  })
  assert.equal(
    readFileSync(join(agentDir, 'packages/skill/scanpy/1.3.0/scripts/helper.py'), 'utf8'),
    'print("complete resource")\n'
  )
  const items = skillCatalogItems(knownSkillCatalogPackages([registry]))
  assert.deepEqual(
    skillCatalogGroups(items).map(({ label, count }) => [label, count]),
    [
      ['全部技能', 3],
      ['软件包', 1],
      ['biology', 1],
      ['biology/single-cell', 1]
    ]
  )
  assert.deepEqual(
    filterSkillCatalogItems(items, 'category:biology/single-cell', '').map(({ entry }) => entry.id),
    ['scanpy']
  )
})

test('explicit skill categories override directory groups without changing package identity', () => {
  const root = fixture()
  skill(root, 'biology/single-cell/scanpy', '单细胞分析')
  const entry = build(root).packages[0]
  assert.equal(entry.id, 'scanpy')
  assert.equal(entry.category, '单细胞分析')
})

test('same-name skills in different groups fail before any archive is written', () => {
  const root = fixture()
  skill(root, 'biology/scanpy')
  skill(root, 'analysis/scanpy')
  assert.throws(() => build(root), /重复技能 ID.*scanpy/i)
  assert.equal(existsSync(join(root, 'registry')), false)
})

test('skill content checks validate grouped leaves and retain their relative paths in diagnostics', () => {
  const root = fixture()
  skill(root, 'biology/single-cell/scanpy')
  skill(root, 'find-skills')
  write(root, 'biology/README.md', 'Group documentation.\n')
  const result = spawnSync(
    process.execPath,
    ['--import', './scripts/test-loader.mjs', 'scripts/content/check-skills.ts', '--source', root],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 20_000 }
  )
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.match(result.stdout, /biology\/single-cell\/scanpy: 0 error/)
  assert.match(result.stdout, /2 skills, 0 errors/)
})
