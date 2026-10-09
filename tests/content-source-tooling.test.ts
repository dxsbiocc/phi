import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  packageSourceRoot,
  parseContentSourceArgs,
  phiSourceRoot,
  requirePackageSourceRoot,
  requireSourceDirectory
} from '../scripts/content/source-roots.mjs'
import { parseSmokeVizArgs } from '../scripts/runtime/smoke-viz'
import { buildRegistry } from '../scripts/packages/build-registry'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))

test('source defaults follow checkout ownership rather than the current directory', () => {
  const previous = process.env.PHI_PACKAGES_ROOT
  try {
    delete process.env.PHI_PACKAGES_ROOT
    assert.equal(packageSourceRoot(undefined, '/workspace/Phi'), '/workspace/phi-packages')
    process.env.PHI_PACKAGES_ROOT = '/configured/content'
    assert.equal(packageSourceRoot(undefined, '/workspace/Phi'), '/configured/content')
    assert.equal(packageSourceRoot('/selected/content', '/workspace/Phi'), '/selected/content')
    assert.equal(parseContentSourceArgs([]), phiSourceRoot)
  } finally {
    if (previous === undefined) delete process.env.PHI_PACKAGES_ROOT
    else process.env.PHI_PACKAGES_ROOT = previous
  }
})

test('explicit content checks accept a source checkout and reject missing required trees', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-content-tooling-'))
  const previous = process.env.PHI_PACKAGES_ROOT
  try {
    process.env.PHI_PACKAGES_ROOT = '/missing/configured-content'
    assert.throws(() => requirePackageSourceRoot(root), /Content directory not found.*--source/)
    mkdirSync(join(root, 'resources'))
    assert.equal(parseContentSourceArgs(['--source', root]), root)
    assert.throws(
      () => requireSourceDirectory(root, 'resources/connectors'),
      /resources\/connectors/
    )
    assert.throws(() => parseContentSourceArgs(['--source']), /requires a checkout/)
    assert.throws(() => parseContentSourceArgs(['--unknown']), /Unknown argument/)
  } finally {
    if (previous === undefined) delete process.env.PHI_PACKAGES_ROOT
    else process.env.PHI_PACKAGES_ROOT = previous
    rmSync(root, { recursive: true, force: true })
  }
})

test('registry builds honor explicit repoRoot before the configured package checkout', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-registry-explicit-source-'))
  const previous = process.env.PHI_PACKAGES_ROOT
  try {
    process.env.PHI_PACKAGES_ROOT = '/missing/configured-content'
    const skill = join(root, 'resources/skills/explicit-skill')
    mkdirSync(skill, { recursive: true })
    writeFileSync(
      join(skill, 'SKILL.md'),
      '---\nname: explicit-skill\ndescription: Explicit source fixture.\n---\n\n# Explicit skill\n'
    )
    execFileSync('git', ['init', '--quiet'], { cwd: root })
    execFileSync('git', ['add', 'resources'], { cwd: root })
    const index = buildRegistry({ repoRoot: root, outDir: join(root, 'output') })
    assert.deepEqual(
      index.packages.map((entry) => entry.id),
      ['explicit-skill']
    )
  } finally {
    if (previous === undefined) delete process.env.PHI_PACKAGES_ROOT
    else process.env.PHI_PACKAGES_ROOT = previous
    rmSync(root, { recursive: true, force: true })
  }
})

test('visualization smoke uses an explicit template fixture without requiring public content', () => {
  const options = parseSmokeVizArgs(['--templates', '/fixture/templates'])
  assert.equal(options.templatesDir, '/fixture/templates')
  assert.equal(options.specDir, join(repoRoot, 'resources/runtime/environments/phi-r'))
  assert.throws(
    () => parseSmokeVizArgs(['--source', '/missing/phi-packages-fixture']),
    /Content directory not found.*phi-packages-fixture/
  )
})

test('content CLI commands fail clearly for missing sources before building or changing files', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-content-cli-'))
  try {
    const source = join(root, 'missing-source')
    const out = join(root, 'output')
    const scripts = [
      ['scripts/content/check-connectors.ts'],
      ['scripts/content/check-plugins.ts'],
      ['scripts/content/check-skills.ts'],
      ['scripts/content/check-package-content.mjs'],
      ['scripts/smoke-wrappers.mjs', '--offline'],
      ['scripts/generate-wrapper-dags.mjs'],
      ['scripts/wrappers/migrate-defaults.ts'],
      ['scripts/packages/build-registry.ts', '--out', out],
      ['scripts/content/sync-plugin-palettes.mjs', '--check']
    ]
    for (const [script, ...args] of scripts) {
      const result = spawnSync(
        process.execPath,
        ['--import', './scripts/test-loader.mjs', script, ...args, '--source', source],
        { cwd: repoRoot, encoding: 'utf8', timeout: 20_000 }
      )
      assert.ok(result.status !== 0, `${script} must fail without its source`)
      assert.match(result.stderr, /Content directory not found/, script)
      assert.equal(existsSync(source), false, script)
      assert.equal(existsSync(out), false, script)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('palette sync requires an explicit writable content source', () => {
  const result = spawnSync(process.execPath, ['scripts/content/sync-plugin-palettes.mjs'], {
    cwd: repoRoot,
    encoding: 'utf8'
  })
  assert.ok(result.status !== 0)
  assert.match(result.stderr, /Palette sync writes package content; pass --source/)
})
