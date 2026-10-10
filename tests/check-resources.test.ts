import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  misplacedPhiResourcePaths,
  offendingResourcePaths,
  runtimeMirrorPrefixErrors
} from '../scripts/check-resources.mjs'

test('runtime manifest assigns ordered mirrors to every micromamba platform', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../resources/runtime/manifest.json', import.meta.url), 'utf8')
  ) as {
    micromamba: {
      platforms: Record<string, { url: string; mirrorPrefixes?: string[] }>
    }
  }
  for (const release of Object.values(manifest.micromamba.platforms)) {
    assert.equal(new URL(release.url).hostname, 'github.com')
    assert.deepEqual(release.mirrorPrefixes, ['https://gh-proxy.com/', 'https://ghfast.top/'])
  }
})

test('runtime mirror prefixes accept optional ordered HTTPS prefix lists', () => {
  assert.deepEqual(
    runtimeMirrorPrefixErrors({
      micromamba: {
        platforms: {
          'linux-x64': {
            mirrorPrefixes: ['https://gh-proxy.com/', 'https://ghfast.top/']
          },
          'linux-arm64': {}
        }
      }
    }),
    []
  )
})

test('runtime mirror prefixes reject unsafe or non-prefix values', () => {
  assert.deepEqual(
    runtimeMirrorPrefixErrors({
      micromamba: {
        platforms: {
          'linux-x64': {
            mirrorPrefixes: [
              'http://mirror.test/',
              'https://user:secret@mirror.test/',
              'https://mirror.test/no-trailing-slash'
            ]
          },
          'linux-arm64': { mirrorPrefixes: 'https://mirror.test/' }
        }
      }
    }),
    [
      'micromamba.platforms.linux-x64.mirrorPrefixes[0] must be an HTTPS URL without userinfo and ending in /',
      'micromamba.platforms.linux-x64.mirrorPrefixes[1] must be an HTTPS URL without userinfo and ending in /',
      'micromamba.platforms.linux-x64.mirrorPrefixes[2] must be an HTTPS URL without userinfo and ending in /',
      'micromamba.platforms.linux-arm64.mirrorPrefixes must be a string array'
    ]
  )
})

test('Phi resources retain core assets and the private Office plugin', () => {
  assert.deepEqual(
    misplacedPhiResourcePaths([
      'resources/README.md',
      'resources/icon.png',
      'resources/icons/catalog.json',
      'resources/icons/agent/gentle-fox.webp',
      'resources/agents/Wrapper.md',
      'resources/runtime/manifest.json',
      'resources/runtime/micromamba/darwin-arm64/micromamba',
      'resources/remote-helper/0.1.0/linux-amd64/phi-helper',
      'resources/office/manifest.json',
      'resources/office/officecli/darwin-arm64/officecli',
      'resources/palettes/default.yaml',
      'resources/skills',
      'resources/skills/create-wrapper/SKILL.md',
      'resources/plugins',
      'resources/plugins/office/skills/xlsx/SKILL.md'
    ]),
    []
  )
})

test('Phi resources reject retired and distributable source roots even when empty', () => {
  const misplaced = [
    'resources/db-connectors',
    'resources/connectors/pubmed/phi-package.yaml',
    'resources/wrappers',
    'resources/skills/nextflow/SKILL.md',
    'resources/plugins/visualization',
    'resources\\plugins\\future-plugin\\phi-plugin.yaml',
    'resources/unknown'
  ]
  assert.deepEqual(misplacedPhiResourcePaths(misplaced), misplaced)
})

test('resource check allows .DS_Store but no retired wrapper pack index', () => {
  assert.deepEqual(
    offendingResourcePaths([
      'resources/.DS_Store',
      'resources/README.md',
      'resources/wrappers/modules/local/differential-expression/deseq2/.DS_Store'
    ]),
    []
  )
  assert.deepEqual(offendingResourcePaths(['resources/wrappers/index.json']), [
    'resources/wrappers/index.json'
  ])
})

test('resource check allows fetched runtime binaries and nothing else under resources/runtime', () => {
  assert.deepEqual(
    offendingResourcePaths([
      'resources/runtime/micromamba/darwin-arm64/micromamba',
      'resources/runtime/micromamba/darwin-x64/micromamba',
      'resources/runtime/micromamba/linux-x64/micromamba',
      'resources\\runtime\\micromamba\\linux-x64\\micromamba',
      'resources/runtime/bun/darwin-arm64/bun',
      'resources\\runtime\\bun\\darwin-arm64\\bun'
    ]),
    []
  )
  assert.deepEqual(
    offendingResourcePaths([
      'resources/runtime/manifest.json',
      'resources/runtime/micromamba',
      'resources/runtime/micromamba-extra',
      'resources/runtime/bun',
      'resources/runtime/bun-extra'
    ]),
    [
      'resources/runtime/manifest.json',
      'resources/runtime/micromamba',
      'resources/runtime/micromamba-extra',
      'resources/runtime/bun',
      'resources/runtime/bun-extra'
    ]
  )
})

test('resource check allows cross-compiled remote helper artifacts', () => {
  assert.deepEqual(
    offendingResourcePaths([
      'resources/remote-helper/manifest.json',
      'resources/remote-helper/0.1.0/linux-amd64/phi-helper',
      'resources/remote-helper/0.1.0/linux-arm64/phi-helper'
    ]),
    []
  )
})

test('resource check allows developer-fetched OfficeCLI while rejecting adjacent leftovers', () => {
  assert.deepEqual(
    offendingResourcePaths(['resources/office/officecli/darwin-arm64/officecli']),
    []
  )
  assert.deepEqual(offendingResourcePaths(['resources/office/officecli-backup/officecli']), [
    'resources/office/officecli-backup/officecli'
  ])
})

test('resource check rejects Nextflow leftovers and other untracked files', () => {
  const untracked = [
    'resources/wrappers/modules/local/differential-expression/deseq2/.nextflow/x',
    'resources/wrappers/modules/local/differential-expression/deseq2/.nextflow.log',
    'resources/wrappers/notes.txt'
  ]
  assert.deepEqual(offendingResourcePaths(untracked), untracked)
})

test('resource check requires curated icon files to be tracked', () => {
  const paths = [
    'resources/icons/catalog.json',
    'resources/icons/NOTICE.md',
    'resources/icons/agent/gentle-fox.webp',
    'resources\\icons\\skill\\petri-dish.webp',
    'resources/icons/private-key.pem'
  ]
  assert.deepEqual(offendingResourcePaths(paths), paths)
})
