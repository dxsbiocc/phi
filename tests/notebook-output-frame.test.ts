import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import {
  javascriptDocument,
  notebookOutputFrameDocument
} from '../src/renderer/src/features/analysis/lib/notebookOutputFrameDocument'
import { extractVegaSpecFromHtml } from '../src/renderer/src/features/analysis/notebook/notebookOutputUtils'
import { zoomNumericDomain } from '../src/renderer/src/features/analysis/notebook/NotebookRichOutput'
import {
  NOTEBOOK_OUTPUT_CSP,
  notebookOutputFrameId,
  notebookOutputFrameUrl
} from '../src/shared/notebookOutputFrame'

test('notebook javascript output provides Jupyter element and require', () => {
  const html = javascriptDocument(
    'element.append(\'<svg id="d3-like"></svg>\'); require(["d3"], function() {})',
    'frame-1'
  )

  assert.match(html, /data-phi-notebook-output-script-runtime="true"/)
  assert.match(html, /require\.config/)
  assert.match(html, /window\.require/)
  assert.match(html, /window\.define/)
  assert.match(html, /id="phi-js-output"/)
  assert.match(html, /window\.element/)
  assert.match(html, /element\.on =/)
  assert.match(html, /element\.css =/)
  assert.match(html, /d3-like/)
  assert.doesNotMatch(html, /max-width: 100%[^<]*canvas/)
})

test('altair 6 html is rendered as an in-app vega spec', () => {
  const html = `<div id="altair-viz-1"></div>
<script type="text/javascript">
  (function(spec, embedOpt){
    if (typeof define === "function" && define.amd) {
      requirejs.config({paths: {}});
    }
  })({"$schema":"https://vega.github.io/schema/vega-lite/v6.json","data":{"name":"data-1"},"mark":{"type":"circle"},"encoding":{"x":{"field":"x","type":"quantitative"}},"datasets":{"data-1":[{"x":1,"y":2}]}}, {"mode":"vega-lite"});
</script>`

  const extracted = extractVegaSpecFromHtml(html)
  assert.ok(extracted)
  assert.equal(extracted.spec.mark && (extracted.spec.mark as { type?: string }).type, 'circle')
  assert.deepEqual((extracted.spec.datasets as { 'data-1': Array<{ x: number }> })['data-1'], [
    { x: 1, y: 2 }
  ])

  const frame = notebookOutputFrameDocument({
    html,
    frameId: 'frame-1',
    frameKind: 'html'
  })
  assert.doesNotMatch(frame, /data-phi-notebook-output-script-runtime/)

  const rendererSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/features/analysis/notebook/NotebookRichOutput.tsx'),
    'utf8'
  )
  assert.match(rendererSource, /ast:\s*true/)
  assert.match(rendererSource, /right: 6/)
  assert.match(rendererSource, /opacity: 0/)
  assert.match(
    rendererSource,
    /&:hover \.notebook-output-hover-actions, &:focus-within \.notebook-output-hover-actions/
  )
})

test('notebook chart zoom keeps the domain centered', () => {
  assert.deepEqual(zoomNumericDomain([0, 10], 0.5), [2.5, 7.5])
  assert.deepEqual(zoomNumericDomain([2, 8], 2), [-1, 11])
  assert.equal(zoomNumericDomain([4], 0.5), null)
  assert.equal(zoomNumericDomain([3, 3], 0.5), null)
})

test('notebook output frame origin is separate and can run chart scripts', () => {
  const id = '123e4567-e89b-42d3-a456-426614174000'
  const url = notebookOutputFrameUrl(id)

  assert.equal(notebookOutputFrameId(url), id)
  assert.equal(notebookOutputFrameId('https://example.com/'), null)
  assert.equal(notebookOutputFrameId(`${url}index.html`), id)
  assert.match(NOTEBOOK_OUTPUT_CSP, /script-src 'unsafe-inline' 'unsafe-eval' https:/)
  assert.match(NOTEBOOK_OUTPUT_CSP, /connect-src https:/)
  assert.doesNotMatch(NOTEBOOK_OUTPUT_CSP, /script-src 'self'/)

  const renderer = readFileSync(resolve(process.cwd(), 'src/renderer/index.html'), 'utf8')
  assert.match(renderer, /frame-src 'self' data: blob: phi-output:/)
  assert.match(renderer, /script-src 'self'/)
})
