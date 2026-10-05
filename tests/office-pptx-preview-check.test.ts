import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  checkOfficePptxPreview,
  inspectStartedOfficePptxPreview,
  parseOfficePptxSlideCount,
  readOfficePptxSlideCount
} from '../src/main/agent/office/office-pptx-preview-check'

const previewPage = (slides: string, thumbs: string, counter: string): string =>
  `<html><body><div class="sidebar">${thumbs}</div><div class="main">${slides}</div><div class="page-counter">${counter}</div></body></html>`

const inspection = (slides: number, childCount = slides): unknown => ({
  success: true,
  data: {
    matches: 1,
    results: [
      {
        path: '/',
        type: 'presentation',
        childCount,
        children: Array.from({ length: slides }, (_, index) => ({
          path: `/slide[${index + 1}]`,
          type: 'slide'
        }))
      }
    ]
  }
})

test('accepts the real zero-slide preview state without a fake slide or thumbnail', () => {
  assert.deepEqual(checkOfficePptxPreview(previewPage('', '', '1 / 0'), 0), {
    state: 'ready',
    slideCount: 0
  })
})

test('accepts a non-empty preview only when slides, thumbnails, and counter match get', () => {
  const slides = '<div class="slide-container"><div class="slide"></div></div>'.repeat(2)
  const thumbs = '<div class="thumb"><div class="thumb-inner"></div></div>'.repeat(2)

  assert.deepEqual(checkOfficePptxPreview(previewPage(slides, thumbs, '1 / 2'), 2), {
    state: 'ready',
    slideCount: 2
  })
})

test('rejects a fake slide in a presentation reported as zero-slide', () => {
  const fakeSlide = '<div class="slide-container"><div class="slide">占位页</div></div>'
  const result = checkOfficePptxPreview(previewPage(fakeSlide, '', '1 / 0'), 0)

  assert.equal(result.state, 'preview_failed')
  if (result.state === 'preview_failed') assert.match(result.message, /数量与文档不一致/)
})

test('rejects a preview whose slide count, thumbnail count, or counter differs from get', () => {
  const oneSlide = '<div class="slide-container"><div class="slide"></div></div>'
  const oneThumb = '<div class="thumb"><div class="thumb-inner"></div></div>'

  for (const html of [
    previewPage(oneSlide, oneThumb.repeat(2), '1 / 2'),
    previewPage(oneSlide.repeat(2), oneThumb, '1 / 2'),
    previewPage(oneSlide.repeat(2), oneThumb.repeat(2), '1 / 1')
  ]) {
    const result = checkOfficePptxPreview(html, 2)
    assert.equal(result.state, 'preview_failed')
    if (result.state === 'preview_failed') assert.match(result.message, /数量与文档不一致/)
  }
})

test('rejects an impossible current page for a non-empty presentation', () => {
  const slides = '<div class="slide-container"><div class="slide"></div></div>'.repeat(2)
  const thumbs = '<div class="thumb"><div class="thumb-inner"></div></div>'.repeat(2)

  for (const counter of ['0 / 2', '3 / 2']) {
    const result = checkOfficePptxPreview(previewPage(slides, thumbs, counter), 2)
    assert.equal(result.state, 'preview_failed')
    if (result.state === 'preview_failed') assert.match(result.message, /当前页/)
  }
})

test('rejects preview HTML without the PowerPoint presentation container', () => {
  const result = checkOfficePptxPreview('<html><body>not a presentation</body></html>', 0)
  assert.equal(result.state, 'preview_failed')
  if (result.state === 'preview_failed') assert.match(result.message, /演示文稿容器/)
})

test('started preview health returns the get slide count after matching rendered HTML', async () => {
  const slide = '<div class="slide-container"><div class="slide"></div></div>'
  const thumb = '<div class="thumb"><div class="thumb-inner"></div></div>'

  assert.deepEqual(
    await inspectStartedOfficePptxPreview('/officecli', '/draft.pptx', 'http://preview/', {
      inspect: async () => 1,
      loadHtml: async () => previewPage(slide, thumb, '1 / 1')
    }),
    { previewState: 'ready', slideCount: 1 }
  )
})

test('parses the slide count only from a coherent get / presentation result', () => {
  assert.equal(parseOfficePptxSlideCount(inspection(0)), 0)
  assert.equal(parseOfficePptxSlideCount(inspection(2)), 2)
  assert.throws(() => parseOfficePptxSlideCount(inspection(1, 2)), /invalid pptx inspection/)
  assert.throws(
    () => parseOfficePptxSlideCount({ success: true, data: { results: [] } }),
    /invalid pptx inspection/
  )
})

test('reads the PPTX slide count through get / with the controlled resident environment', async () => {
  const root = mkdtempSync(join(tmpdir(), 'office pptx preview '))
  const binaryPath = join(root, 'officecli')
  const callsPath = join(root, 'calls.txt')
  const draftPath = join(root, 'draft with spaces.pptx')
  writeFileSync(
    binaryPath,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*|$OFFICECLI_SKIP_UPDATE|$OFFICECLI_RESIDENT_FLUSH" > '${callsPath}'`,
      `printf '%s\\n' '${JSON.stringify(inspection(0))}'`
    ].join('\n')
  )
  chmodSync(binaryPath, 0o755)
  try {
    assert.equal(await readOfficePptxSlideCount(binaryPath, draftPath), 0)
    assert.equal(readFileSync(callsPath, 'utf8').trim(), `get ${draftPath} / --json|1|each`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('preview_failed retains an inspected slide count when rendered HTML disagrees', async () => {
  const health = await inspectStartedOfficePptxPreview(
    '/officecli',
    '/draft.pptx',
    'http://preview/',
    {
      inspect: async () => 2,
      loadHtml: async () => previewPage('', '', '1 / 0')
    }
  )

  assert.equal(health.previewState, 'preview_failed')
  assert.equal(health.slideCount, 2)
  if (health.previewState === 'preview_failed')
    assert.match(health.previewError, /数量与文档不一致/)
})

test('preview_failed omits slide count when get inspection itself fails', async () => {
  const health = await inspectStartedOfficePptxPreview(
    '/officecli',
    '/draft.pptx',
    'http://preview/',
    {
      inspect: async () => {
        throw new Error('bad get result')
      },
      loadHtml: async () => previewPage('', '', '1 / 0')
    }
  )

  assert.deepEqual(health, {
    previewState: 'preview_failed',
    previewError: '预览渲染失败：无法检查预览页面'
  })
})
