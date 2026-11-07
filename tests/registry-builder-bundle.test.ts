import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { stringify } from 'yaml'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const roots: string[] = []
test.after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })))

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function packagesFixture(): string {
  const root = tempRoot('phi-standalone-registry-src-')
  mkdirSync(join(root, 'resources/plugins'), { recursive: true })
  const skill = join(root, 'resources/skills/demo-skill')
  mkdirSync(skill, { recursive: true })
  writeFileSync(
    join(skill, 'SKILL.md'),
    `---\n${stringify({
      name: 'demo-skill',
      description: 'Standalone builder fixture',
      metadata: { version: '1.2.0' }
    })}---\n# demo-skill\n`
  )
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  execFileSync('git', ['add', 'resources'], { cwd: root })
  return root
}

test('the bundled registry builder runs on plain Node away from the Phi checkout', () => {
  const bundleDir = join(tempRoot('phi-standalone-registry-bin-'), 'registry-builder')
  const bundled = spawnSync(
    'bun',
    [join(repoRoot, 'scripts/packages/bundle-registry-builder.ts'), '--out', bundleDir],
    { cwd: repoRoot, encoding: 'utf8' }
  )
  assert.equal(bundled.status, 0, bundled.stderr)

  const source = packagesFixture()
  const out = join(tempRoot('phi-standalone-registry-out-'), 'registry')
  // Run from the bundle directory so nothing resolves through the Phi checkout.
  const built = spawnSync(
    process.execPath,
    ['phi-registry-builder.mjs', '--source', source, '--out', out],
    { cwd: bundleDir, encoding: 'utf8' }
  )
  assert.equal(built.status, 0, built.stderr)
  assert.match(built.stdout, /Built 1 packages/)

  const index = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'))
  assert.equal(index.schemaVersion, 1)
  assert.deepEqual(
    index.packages.map((entry: { type: string; id: string; version: string }) => [
      entry.type,
      entry.id,
      entry.version
    ]),
    [['skill', 'demo-skill', '1.2.0']]
  )
})

test('the standalone builder explains its arguments when they are missing', () => {
  const bundleDir = join(tempRoot('phi-standalone-registry-usage-'), 'registry-builder')
  mkdirSync(bundleDir, { recursive: true })
  writeFileSync(
    join(bundleDir, 'registry-builder-lib.mjs'),
    'export function buildRegistryWithReport() {}\n'
  )
  writeFileSync(
    join(bundleDir, 'phi-registry-builder.mjs'),
    readFileSync(join(repoRoot, 'scripts/packages/registry-builder-cli.mjs'))
  )
  const run = spawnSync(process.execPath, ['phi-registry-builder.mjs', '--source'], {
    cwd: bundleDir,
    encoding: 'utf8'
  })
  assert.equal(run.status, 2)
  assert.match(run.stderr, /usage: phi-registry-builder\.mjs --source/)
})
