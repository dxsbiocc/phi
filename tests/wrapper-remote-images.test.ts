import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { getBundledWrapperPackagesDir } from '../src/main/agent/wrappers/catalog'
import {
  collectWrapperSingularityImages,
  singularityCacheFileName,
  stageSingularityImages
} from '../src/main/agent/wrappers/composition/remote-images'
import { createLocalShellSession } from './helpers/localShellSession'

function withTempDir(fn: (dir: string) => Promise<void> | void): Promise<void> | void {
  const dir = mkdtempSync(join(tmpdir(), 'phi-remote-images-'))
  const done = (): void => rmSync(dir, { recursive: true, force: true })
  try {
    const result = fn(dir)
    if (result instanceof Promise) return result.finally(done)
    done()
    return undefined
  } catch (error) {
    done()
    throw error
  }
}

test('cache file names follow Nextflow singularity cache naming', () => {
  assert.equal(
    singularityCacheFileName('https://depot.galaxyproject.org/singularity/fq:0.12.0--h9ee0642_0'),
    'depot.galaxyproject.org-singularity-fq-0.12.0--h9ee0642_0.img'
  )
  assert.equal(
    singularityCacheFileName(
      'https://community-cr-prod.seqera.io/docker/registry/v2/blobs/sha256/d0/d013aad5/data'
    ),
    'community-cr-prod.seqera.io-docker-registry-v2-blobs-sha256-d0-d013aad5-data.img'
  )
  assert.equal(
    singularityCacheFileName('https://example.org/tools/x.sif'),
    'example.org-tools-x.sif'
  )
})

test('a wrapper needs the images of every module it includes, followed through includes', () => {
  const root = getBundledWrapperPackagesDir()
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

test('images already in the cache are left alone; missing ones are fetched on the server', async () => {
  await withTempDir(async (dir) => {
    const source = join(dir, 'source')
    const cacheDir = join(dir, 'remote/cache')
    mkdirSync(source, { recursive: true })
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(join(source, 'a.img'), 'image A')
    writeFileSync(join(source, 'b.img'), 'image B')
    const images = [
      { url: `file://${join(source, 'a.img')}`, fileName: 'a.img' },
      { url: `file://${join(source, 'b.img')}`, fileName: 'b.img' }
    ]
    writeFileSync(join(cacheDir, 'a.img'), 'already cached')

    const session = createLocalShellSession()
    const lines: string[] = []
    const result = await stageSingularityImages(session, {
      images,
      cacheDir,
      onOutput: (line) => lines.push(line),
      downloadLocally: async () => {
        throw new Error('the server could fetch it itself')
      }
    })

    assert.deepEqual(result, { staged: ['b.img'], failed: [] })
    assert.equal(readFileSync(join(cacheDir, 'a.img'), 'utf-8'), 'already cached')
    assert.equal(readFileSync(join(cacheDir, 'b.img'), 'utf-8'), 'image B')
    assert.equal(session.uploads.length, 0)
    assert.ok(lines.some((line) => line.includes('b.img')))
  })
})

test('an image the server cannot fetch is downloaded here and uploaded; a total failure is reported', async () => {
  await withTempDir(async (dir) => {
    const cacheDir = join(dir, 'remote/cache')
    const images = [
      { url: 'file:///nonexistent/phi/c.img', fileName: 'c.img' },
      { url: 'file:///nonexistent/phi/d.img', fileName: 'd.img' }
    ]
    const session = createLocalShellSession()
    const result = await stageSingularityImages(session, {
      images,
      cacheDir,
      downloadLocally: async (url, target) => {
        if (url.endsWith('d.img')) throw new Error('offline here too')
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, 'image C from this machine')
      }
    })

    assert.deepEqual(result.staged, ['c.img'])
    assert.equal(result.failed.length, 1)
    assert.equal(result.failed[0].fileName, 'd.img')
    assert.match(result.failed[0].reason, /offline here too/)
    assert.equal(readFileSync(join(cacheDir, 'c.img'), 'utf-8'), 'image C from this machine')
    assert.equal(existsSync(join(cacheDir, 'd.img')), false)
    // No half-written file is left where Nextflow would take it for a real image.
    assert.deepEqual(
      (await session.exec(`ls ${cacheDir}`)).stdout.trim().split('\n').filter(Boolean),
      ['c.img']
    )
  })
})
