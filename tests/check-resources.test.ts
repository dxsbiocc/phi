import assert from 'node:assert/strict'
import test from 'node:test'

import { misplacedPhiResourcePaths, offendingResourcePaths } from '../scripts/check-resources.mjs'

test('Phi resources retain core assets and the private Office plugin', () => {
  assert.deepEqual(
    misplacedPhiResourcePaths([
      'resources/README.md',
      'resources/icon.png',
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

test('resource check rejects Nextflow leftovers and other untracked files', () => {
  const untracked = [
    'resources/wrappers/modules/local/differential-expression/deseq2/.nextflow/x',
    'resources/wrappers/modules/local/differential-expression/deseq2/.nextflow.log',
    'resources/wrappers/notes.txt'
  ]
  assert.deepEqual(offendingResourcePaths(untracked), untracked)
})
