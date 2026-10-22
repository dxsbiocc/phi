import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { readEnablementState, writeEnablementState } from '../src/main/agent/enablement'
import { readWrapperTreeState } from '../src/main/agent/packages/wrapper-tree'
import { isLegacyPackageRegistry } from '../src/shared/packageSourceIds'
import {
  legacyBundledKeepIds,
  retireLegacyBundledWrappers,
  type LegacyBundledRoot
} from '../src/main/agent/wrappers/legacy-bundled-cleanup'

const roots: string[] = []
test.after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })))

interface Fixture {
  id: string
  registry: 'bundled-wrappers' | 'phi-packages'
  dependsOn?: string[]
}

function makeAgentDir(fixtures: Fixture[], enablement: Record<string, boolean> = {}): string {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-wrapper-legacy-bundled-'))
  roots.push(agentDir)
  const treeDir = join(agentDir, 'wrappers', 'tree')
  const packages: Record<string, unknown> = {}
  for (const fixture of fixtures) {
    const file = `modules/nf-core/${fixture.id}/main.nf`
    mkdirSync(dirname(join(treeDir, file)), { recursive: true })
    writeFileSync(join(treeDir, file), 'process X {}\n')
    packages[fixture.id] = {
      version: '1.0.0',
      title: fixture.id,
      summary: '',
      manifest: {
        schemaVersion: 1,
        id: fixture.id,
        type: 'wrapper',
        version: '1.0.0',
        title: fixture.id,
        summary: '',
        dependsOn: (fixture.dependsOn ?? []).map((dependency) => ({
          id: dependency,
          type: 'wrapper',
          version: '^1.0.0'
        })),
        files: 'files.json'
      },
      source: {
        registry: fixture.registry,
        id: fixture.id,
        type: 'wrapper',
        version: '1.0.0',
        sha256: 'a'.repeat(64),
        installedAt: '2026-10-08T00:00:00.000Z',
        installedBy: 'user',
        trust: fixture.registry === 'phi-packages' ? 'official' : 'builtin'
      },
      paths: [file]
    }
  }
  mkdirSync(join(agentDir, 'wrappers'), { recursive: true })
  writeFileSync(join(agentDir, 'wrappers', 'tree.json'), JSON.stringify({ version: 1, packages }))
  writeFileSync(join(agentDir, 'wrappers', 'bundled.json'), '{"version":1}\n')
  writeEnablementState({ version: 1, global: enablement, projects: {} }, { agentDir })
  return agentDir
}

type Tree = {
  packages: Record<
    string,
    {
      source: { registry: string; trust: string }
      manifest: { dependsOn: Array<{ id: string; type: string }> }
    }
  >
}

function readTree(agentDir: string): Tree {
  return JSON.parse(readFileSync(join(agentDir, 'wrappers', 'tree.json'), 'utf8')) as Tree
}

function writeTree(agentDir: string, tree: Tree): void {
  writeFileSync(join(agentDir, 'wrappers', 'tree.json'), JSON.stringify(tree))
}

function legacyDependencies(tree: Tree, id: string): string[] {
  const legacy: string[] = []
  const seen = new Set<string>()
  const visit = (current: string): void => {
    for (const dependency of tree.packages[current]?.manifest.dependsOn ?? []) {
      if (dependency.type !== 'wrapper' || seen.has(dependency.id)) continue
      seen.add(dependency.id)
      if (!tree.packages[dependency.id]) continue
      if (isLegacyPackageRegistry(tree.packages[dependency.id].source.registry)) {
        legacy.push(dependency.id)
      }
      visit(dependency.id)
    }
  }
  visit(id)
  return legacy
}

/** Pretend the catalog install ran: replace exactly what that install would have replaced. */
function fakeCatalog(
  agentDir: string,
  options: { failFor?: ReadonlySet<string> } = {}
): (roots: LegacyBundledRoot[], agentDir: string) => Promise<void> {
  return async (requested) => {
    const tree = readTree(agentDir)
    for (const root of requested) {
      if (options.failFor?.has(root.id)) throw new Error(`catalog unavailable: ${root.id}`)
      const isLegacyRoot =
        tree.packages[root.id] !== undefined &&
        isLegacyPackageRegistry(tree.packages[root.id].source.registry)
      const ids = isLegacyRoot ? [root.id] : legacyDependencies(tree, root.id)
      for (const id of ids) {
        if (!tree.packages[id]) continue
        tree.packages[id].source = {
          ...tree.packages[id].source,
          registry: 'phi-packages',
          trust: 'official'
        }
      }
    }
    writeTree(agentDir, tree)
  }
}

test('kept legacy records are the chosen ones plus the dependency closure', () => {
  const agentDir = makeAgentDir([
    { id: 'module-nf-core-custom', registry: 'bundled-wrappers' },
    {
      id: 'module-nf-core-extra',
      registry: 'bundled-wrappers',
      dependsOn: ['module-nf-core-custom']
    },
    { id: 'module-nf-core-blast', registry: 'bundled-wrappers' },
    {
      id: 'module-local-differential-expression',
      registry: 'phi-packages',
      dependsOn: ['module-nf-core-extra']
    }
  ])
  const packages = readWrapperTreeState(agentDir).packages
  assert.deepEqual([...legacyBundledKeepIds(packages, new Set())].sort(), [
    'module-nf-core-custom',
    'module-nf-core-extra'
  ])
  assert.deepEqual([...legacyBundledKeepIds(packages, new Set(['module-nf-core-blast']))].sort(), [
    'module-nf-core-blast',
    'module-nf-core-custom',
    'module-nf-core-extra'
  ])
})

test('kept records become catalog packages and unused records are removed', async () => {
  const agentDir = makeAgentDir(
    [
      { id: 'module-nf-core-custom', registry: 'bundled-wrappers' },
      {
        id: 'module-local-differential-expression',
        registry: 'phi-packages',
        dependsOn: ['module-nf-core-custom']
      },
      { id: 'module-nf-core-blast', registry: 'bundled-wrappers' },
      { id: 'module-nf-core-samtools', registry: 'bundled-wrappers' }
    ],
    {
      'wrapper:module-nf-core-blast': true,
      'wrapper:module-local-differential-expression': true
    }
  )

  const result = await retireLegacyBundledWrappers({
    agentDir,
    installCatalog: fakeCatalog(agentDir)
  })

  assert.deepEqual(result, {
    removed: ['module-nf-core-samtools'],
    replaced: ['module-nf-core-blast', 'module-nf-core-custom'],
    failed: []
  })
  const tree = readWrapperTreeState(agentDir).packages
  assert.deepEqual(Object.keys(tree).sort(), [
    'module-local-differential-expression',
    'module-nf-core-blast',
    'module-nf-core-custom'
  ])
  assert.equal(tree['module-nf-core-custom'].source.registry, 'phi-packages')
  assert.equal(tree['module-nf-core-blast'].source.registry, 'phi-packages')
  assert.equal(tree['module-nf-core-custom'].source.installedBy, 'dependency')
  assert.equal(tree['module-nf-core-blast'].source.installedBy, 'user')
  assert.equal(
    existsSync(
      join(agentDir, 'wrappers', 'tree', 'modules/nf-core/module-nf-core-samtools/main.nf')
    ),
    false
  )
  assert.equal(existsSync(join(agentDir, 'wrappers', 'bundled.json')), false)
  assert.equal(
    readEnablementState({ agentDir }).global['wrapper:module-nf-core-blast'],
    true,
    'a chosen package keeps its choice'
  )
})

test('a record that cannot be replaced is kept and retried next start', async () => {
  const agentDir = makeAgentDir(
    [
      { id: 'module-nf-core-blast', registry: 'bundled-wrappers' },
      { id: 'module-nf-core-samtools', registry: 'bundled-wrappers' }
    ],
    { 'wrapper:module-nf-core-blast': true }
  )

  const result = await retireLegacyBundledWrappers({
    agentDir,
    installCatalog: fakeCatalog(agentDir, { failFor: new Set(['module-nf-core-blast']) })
  })

  assert.deepEqual(result.removed, ['module-nf-core-samtools'])
  assert.deepEqual(result.replaced, [])
  assert.equal(result.failed.length, 1)
  assert.equal(result.failed[0].id, 'module-nf-core-blast')
  assert.equal(
    readWrapperTreeState(agentDir).packages['module-nf-core-blast'].source.registry,
    'bundled-wrappers'
  )
  assert.ok(
    existsSync(join(agentDir, 'wrappers', 'tree', 'modules/nf-core/module-nf-core-blast/main.nf'))
  )
})

test('a clean tree needs no catalog call', async () => {
  const agentDir = makeAgentDir([
    { id: 'module-local-differential-expression', registry: 'phi-packages' }
  ])
  let calls = 0
  const result = await retireLegacyBundledWrappers({
    agentDir,
    installCatalog: async () => {
      calls += 1
    }
  })
  assert.deepEqual(result, { removed: [], replaced: [], failed: [] })
  assert.equal(calls, 0)
  assert.equal(existsSync(join(agentDir, 'wrappers', 'bundled.json')), false)
})
