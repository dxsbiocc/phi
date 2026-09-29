import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import semver from 'semver'

import {
  PACK_INDEX_FILE,
  buildWrapperPackIndex,
  verifyWrapperPack
} from '../src/main/agent/wrappers/composition/pack-index'
import { resolveActiveWrapperPack } from '../src/main/agent/wrappers/composition/packs'
import {
  getActiveWrapperPack,
  listWrapperCompositionCatalog,
  resetWrapperCompositionCatalogCache
} from '../src/main/agent/wrappers/composition/discovery'
import { startCompositionRun } from '../src/main/agent/wrappers/composition/run-record'
import { getBundledWrapperPackagesDir } from '../src/main/agent/wrappers/catalog'

const PACK_NAME = 'phi-wrappers'
const GFFREAD_DIR = join('modules', 'nf-core', 'gffread')

function withTempDir(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'phi-wrapper-packs-'))
  try {
    fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function writePack(
  root: string,
  version: string,
  options: { name?: string; index?: boolean; files?: Record<string, string> } = {}
): string {
  mkdirSync(root, { recursive: true })
  writeFileSync(
    join(root, 'pack.json'),
    JSON.stringify({ schemaVersion: 1, name: options.name ?? PACK_NAME, version })
  )
  for (const [relPath, content] of Object.entries(options.files ?? { 'modules/a/main.nf': 'a' })) {
    mkdirSync(join(root, relPath, '..'), { recursive: true })
    writeFileSync(join(root, relPath), content)
  }
  if (options.index !== false) writeIndex(root)
  return root
}

function writeIndex(root: string): void {
  writeFileSync(join(root, PACK_INDEX_FILE), JSON.stringify(buildWrapperPackIndex(root)))
}

test('pack index covers content but not run leftovers or its own index', () => {
  withTempDir((root) => {
    writePack(root, '1.0.0', {
      files: {
        'modules/a/main.nf': 'a',
        'modules/a/.DS_Store': 'x',
        'modules/a/work/12/ab/.command.sh': 'x',
        'modules/a/.nextflow.log.1': 'x',
        'modules/a/index.json': '{}'
      }
    })
    const index = buildWrapperPackIndex(root)
    assert.deepEqual(Object.keys(index.files), [
      'modules/a/index.json',
      'modules/a/main.nf',
      'pack.json'
    ])
    assert.equal(verifyWrapperPack(root).ok, true)
  })
})

test('pack verification names missing, extra and modified files', () => {
  withTempDir((root) => {
    writePack(root, '1.0.0', { files: { 'modules/a/main.nf': 'a', 'modules/b/main.nf': 'b' } })
    rmSync(join(root, 'modules/b/main.nf'))
    writeFileSync(join(root, 'modules/a/main.nf'), 'changed')
    writeFileSync(join(root, 'modules/a/extra.nf'), 'extra')

    const result = verifyWrapperPack(root)
    assert.equal(result.ok, false)
    assert.ok(!result.ok)
    assert.match(result.reason, /缺少文件：modules\/b\/main\.nf/)
    assert.match(result.reason, /多出文件：modules\/a\/extra\.nf/)
    assert.match(result.reason, /内容被修改：modules\/a\/main\.nf/)
  })
})

test('pack verification rejects an index that does not match pack.json', () => {
  withTempDir((root) => {
    writePack(root, '1.0.0')
    writeFileSync(
      join(root, 'pack.json'),
      JSON.stringify({ schemaVersion: 1, name: PACK_NAME, version: '1.0.1' })
    )
    const result = verifyWrapperPack(root)
    assert.ok(!result.ok)
    assert.match(result.reason, /名称或版本不一致/)
  })
})

test('the bundled pack is active when no overlay exists, with its digest when indexed', () => {
  withTempDir((root) => {
    const bundledRoot = writePack(join(root, 'bundled'), '1.0.0')
    const { active, rejected } = resolveActiveWrapperPack({
      bundledRoot,
      agentDir: join(root, 'agent')
    })
    assert.equal(active.source, 'bundled')
    assert.equal(active.root, bundledRoot)
    assert.equal(active.version, '1.0.0')
    assert.equal(active.digest, buildWrapperPackIndex(bundledRoot).digest)
    assert.deepEqual(rejected, [])

    rmSync(join(bundledRoot, PACK_INDEX_FILE))
    assert.equal(
      resolveActiveWrapperPack({ bundledRoot, agentDir: join(root, 'agent') }).active.digest,
      undefined
    )
  })
})

test('the newest verified overlay replaces the bundled pack; broken or stale ones are reported', () => {
  withTempDir((root) => {
    const bundledRoot = writePack(join(root, 'bundled'), '1.2.0')
    const agentDir = join(root, 'agent')
    const packsDir = join(agentDir, 'wrappers', 'packs')

    writePack(join(packsDir, '1.1.0'), '1.1.0')
    writePack(join(packsDir, '1.2.0'), '1.2.0')
    writePack(join(packsDir, '1.3.0'), '1.3.0')
    const tampered = writePack(join(packsDir, '1.4.0'), '1.4.0')
    writeFileSync(join(tampered, 'modules/a/main.nf'), 'tampered')
    writePack(join(packsDir, '1.5.0'), '1.5.0', { index: false })
    writePack(join(packsDir, '1.6.0'), '1.6.0', { name: 'someone-else' })
    writePack(join(packsDir, 'latest'), '1.7.0')

    const { active, rejected } = resolveActiveWrapperPack({ bundledRoot, agentDir })
    assert.equal(active.source, 'overlay')
    assert.equal(active.version, '1.3.0')
    assert.equal(active.root, join(packsDir, '1.3.0'))
    assert.equal(active.digest, buildWrapperPackIndex(join(packsDir, '1.3.0')).digest)

    const reasons = Object.fromEntries(
      rejected.map((entry) => [entry.root.slice(packsDir.length + 1), entry.reason])
    )
    assert.match(reasons['1.1.0'], /不高于内置版本 1\.2\.0/)
    assert.match(reasons['1.2.0'], /不高于内置版本 1\.2\.0/)
    assert.match(reasons['1.4.0'], /完整性校验失败：内容被修改/)
    assert.match(reasons['1.5.0'], /完整性校验失败：缺少 index\.json/)
    assert.match(reasons['1.6.0'], /包名 someone-else/)
    assert.match(reasons.latest, /目录名 latest 与包版本 1\.7\.0 不一致/)
    assert.equal(reasons['1.3.0'], undefined)
  })
})

test('the bundled pack declares a valid name and version', () => {
  const { active } = resolveActiveWrapperPack({
    bundledRoot: getBundledWrapperPackagesDir(),
    agentDir: join(tmpdir(), 'phi-wrapper-packs-no-agent-dir')
  })
  assert.equal(active.source, 'bundled')
  assert.equal(active.name, PACK_NAME)
})

test('discovery and composition runs use the active overlay pack', () => {
  withTempDir((root) => {
    const saved = process.env.PI_CODING_AGENT_DIR
    const agentDir = join(root, 'agent')
    const bundledMeta = resolveActiveWrapperPack({
      bundledRoot: getBundledWrapperPackagesDir(),
      agentDir
    }).active
    const overlayVersion = semver.inc(bundledMeta.version, 'patch') ?? ''
    const overlayRoot = join(agentDir, 'wrappers', 'packs', overlayVersion)
    cpSync(join(getBundledWrapperPackagesDir(), GFFREAD_DIR), join(overlayRoot, GFFREAD_DIR), {
      recursive: true
    })
    writePack(overlayRoot, overlayVersion, { files: {} })

    process.env.PI_CODING_AGENT_DIR = agentDir
    resetWrapperCompositionCatalogCache()
    try {
      const pack = getActiveWrapperPack()
      assert.equal(pack.source, 'overlay')
      assert.equal(pack.root, overlayRoot)

      const catalog = listWrapperCompositionCatalog()
      assert.deepEqual(
        catalog.map((entry) => entry.manifest.id),
        ['nf-core/modules/gffread']
      )
      assert.ok(catalog[0].wrapperDir.startsWith(overlayRoot))
      assert.equal(catalog[0].pack?.version, overlayVersion)

      const run = startCompositionRun({
        entry: catalog[0],
        params: {},
        profile: 'docker',
        agentDir
      })
      assert.deepEqual(run.pack, {
        name: PACK_NAME,
        version: overlayVersion,
        source: 'overlay',
        digest: pack.digest
      })
    } finally {
      if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = saved
      resetWrapperCompositionCatalogCache()
    }
  })
})
