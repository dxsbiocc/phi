import assert from 'node:assert/strict'
import test from 'node:test'

import { checkOfficeDocxPreview } from '../src/main/agent/office/office-docx-preview-check'

const page = (body: string): string =>
  `<html><body><div class="page-wrapper"><div class="page"><div class="page-body">${body}</div></div></div></body></html>`

test('accepts DOCX preview HTML containing escaped Chinese paragraph text', () => {
  assert.deepEqual(
    checkOfficeDocxPreview(page('<p>中文段落 &amp; &lt;Phi&gt;</p>'), ['中文段落 & <Phi>']),
    { state: 'ready' }
  )
})

test('accepts a structurally empty DOCX page without inventing placeholder text', () => {
  const html = page('')
  assert.deepEqual(checkOfficeDocxPreview(html, []), { state: 'ready' })
  assert.doesNotMatch(html, /开始写作|正文内容|示例段落/u)
})

test('reports preview_failed when the DOCX document container is missing', () => {
  const result = checkOfficeDocxPreview('<html><body>not a document</body></html>', [])
  assert.equal(result.state, 'preview_failed')
  if (result.state === 'preview_failed') assert.match(result.message, /文档容器/)
})

test('reports preview_failed when non-empty DOCX text is absent from the HTML', () => {
  const result = checkOfficeDocxPreview(page('<p>另一段</p>'), ['应该出现的中文'])
  assert.equal(result.state, 'preview_failed')
  if (result.state === 'preview_failed') assert.match(result.message, /正文/)
})
