import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { componentBundleScope } from '../../src/main/agent/wrappers/composition/includes'
import { collectWrapperSingularityImages } from '../../src/main/agent/wrappers/composition/remote-images'
import { packageContentPath } from '../helpers/packageContent'

test('a wrapper needs the images of every module it includes, followed through includes', () => {
  const root = packageContentPath('wrappers')
  const star = collectWrapperSingularityImages(
    join(root, 'modules/nf-core/star/align/wrapper/main.nf')
  )
  // star-align composes star/genomegenerate and star/align.
  const genomegenerate = readFileSync(
    join(root, 'modules/nf-core/star/genomegenerate/main.nf'),
    'utf-8'
  )
  const align = readFileSync(join(root, 'modules/nf-core/star/align/main.nf'), 'utf-8')
  for (const image of star) {
    assert.match(image.url, /^https:\/\//)
    assert.ok(genomegenerate.includes(image.url) || align.includes(image.url), image.url)
  }
  assert.ok(star.length >= 1)
  assert.equal(new Set(star.map((image) => image.url)).size, star.length)

  const subworkflow = collectWrapperSingularityImages(
    join(root, 'subworkflows/local/align_star/wrapper/main.nf')
  )
  assert.ok(
    subworkflow.length > star.length,
    'a subworkflow pulls in more modules than one aligner'
  )
})

test('a run bundle scope covers the component and every module it includes', () => {
  const root = packageContentPath('wrappers')
  assert.deepEqual(componentBundleScope(join(root, 'modules/nf-core/star/align'), root), [
    'modules/nf-core/star/align',
    'modules/nf-core/star/genomegenerate'
  ])
  const scope = componentBundleScope(join(root, 'subworkflows/local/align_star'), root)
  assert.ok(scope.includes('subworkflows/local/align_star'))
  assert.ok(scope.includes('modules/nf-core/star/genomegenerate'))
  assert.ok(scope.some((dir) => dir.startsWith('modules/nf-core/samtools/')))
})
