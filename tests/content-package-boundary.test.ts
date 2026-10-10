import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'

test('desktop packaging keeps the executable and engine while excluding installable domain sources', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-content-package-boundary-'))
  const require = createRequire(import.meta.url)
  const builderRequire = createRequire(require.resolve('electron-builder'))
  const { getMainFileMatchers } = builderRequire('app-builder-lib/out/fileMatcher.js')
  const config = parse(readFileSync('electron-builder.yml', 'utf8'))
  const kept = [
    'out/main/index.mjs',
    'out/preload/index.mjs',
    'out/renderer/index.html',
    'resources/runtime/manifest.json',
    'resources/palettes/default.yaml',
    'resources/icons/catalog.json',
    'resources/icons/agent/gentle-fox.webp',
    'resources/icons/skill/petri-dish.webp',
    'resources/agents/Wrapper.md',
    'resources/skills/create-wrapper/SKILL.md',
    'resources/skills/create-wrapper/references/guide.md'
  ]
  const excluded = [
    'resources/skills/anndata/SKILL.md',
    'resources/skills/future-skill/scripts/run.py',
    'resources/connectors/cbioportal/phi-package.yaml',
    'resources/db-connectors/entrez/connector.yaml',
    'resources/plugins/visualization/phi-package.yaml',
    'resources/wrappers/modules/local/example/wrapper/wrapper.yaml'
  ]
  try {
    for (const path of [...kept, ...excluded]) {
      const file = join(root, path)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, 'fixture')
    }
    const [matcher] = getMainFileMatchers(
      root,
      join(root, 'output'),
      (value: string) => value,
      {},
      {
        info: {
          config,
          projectDir: root,
          buildResourcesDir: 'build',
          debugLogger: { isEnabled: false }
        }
      },
      'release',
      false
    )
    const filter = matcher.createFilter()
    for (const path of kept)
      assert.equal(filter(join(root, path), statSync(join(root, path))), true, path)
    for (const path of excluded)
      assert.equal(filter(join(root, path), statSync(join(root, path))), false, path)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
