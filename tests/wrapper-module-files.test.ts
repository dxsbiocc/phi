import assert from 'node:assert/strict'
import test from 'node:test'

import {
  readModuleDetails,
  readWrapperDag
} from '../src/main/agent/wrappers/composition/module-files'

const files = (entries: Record<string, string>) => (name: string) => entries[name]

test('module details come from meta.yml and environment.yml through any reader', () => {
  const details = readModuleDetails(
    files({
      'meta.yml': [
        'description: Sort BAM files',
        'keywords: [sort, bam]',
        'tools:',
        '  - samtools:',
        '      description: Tools for SAM/BAM',
        '      homepage: http://www.htslib.org/',
        '      licence: ["MIT"]',
        'authors: ["@alice"]'
      ].join('\n'),
      'environment.yml': 'channels:\n  - conda-forge\n'
    })
  )
  assert.equal(details?.meta?.description, 'Sort BAM files')
  assert.deepEqual(details?.meta?.keywords, ['sort', 'bam'])
  assert.equal(details?.meta?.tools?.[0].name, 'samtools')
  assert.deepEqual(details?.meta?.tools?.[0].licence, ['MIT'])
  assert.equal(details?.environment, 'channels:\n  - conda-forge\n')
})

test('missing or malformed files are tolerated, and nothing at all yields undefined', () => {
  assert.equal(readModuleDetails(files({})), undefined)
  const onlyEnvironment = readModuleDetails(
    files({ 'environment.yml': 'a: 1\n', 'meta.yml': ': [' })
  )
  assert.equal(onlyEnvironment?.meta, undefined)
  assert.equal(onlyEnvironment?.environment, 'a: 1\n')
})

test('the wrapper dag is read from dag.mmd when present', () => {
  assert.equal(readWrapperDag(files({ 'dag.mmd': 'flowchart TD' })), 'flowchart TD')
  assert.equal(readWrapperDag(files({})), undefined)
})
