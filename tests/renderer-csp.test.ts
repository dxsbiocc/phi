import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const rendererIndexHtml = fileURLToPath(new URL('../src/renderer/index.html', import.meta.url))

test('renderer CSP does not enable eval for molecule previews', () => {
  const html = readFileSync(rendererIndexHtml, 'utf8')

  assert.match(html, /script-src 'self'/)
  assert.doesNotMatch(html, /script-src[^"]*'wasm-unsafe-eval'/)
  assert.doesNotMatch(html, /script-src[^"]*'unsafe-eval'/)
})
