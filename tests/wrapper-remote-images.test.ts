import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

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

test('a wrapper follows nested and cyclic includes, deduplicates images and ignores Docker-only tags', () => {
  return withTempDir((root) => {
    const files = {
      'wrapper.nf': "include { FIRST } from './first'\ninclude { SECOND } from './second'\n",
      'first.nf':
        "include { SECOND } from './second'\nprocess FIRST {\n container 'https://example.org/first.sif'\n}\n",
      'second/main.nf':
        "include { FIRST } from '../first.nf'\nprocess SECOND {\n container 'https://example.org/first.sif'\n}\nprocess THIRD {\n container 'https://example.org/third.sif'\n}\nprocess DOCKER {\n container 'docker/example:1.0'\n}\n"
    }
    for (const [name, contents] of Object.entries(files)) {
      mkdirSync(dirname(join(root, name)), { recursive: true })
      writeFileSync(join(root, name), contents)
    }
    assert.deepEqual(collectWrapperSingularityImages(join(root, 'wrapper.nf')), [
      { url: 'https://example.org/first.sif', fileName: 'example.org-first.sif' },
      { url: 'https://example.org/third.sif', fileName: 'example.org-third.sif' }
    ])
  })
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
