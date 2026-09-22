import assert from 'node:assert/strict'
import test from 'node:test'
import { renderMoleculeSvg } from '../src/renderer/src/lib/rdkitPreview'

test('renderer molecule preview delegates SVG rendering to preload api', async () => {
  const originalWindow = globalThis.window
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      api: {
        renderMoleculeSvg: async (value: string, width: number, height: number) =>
          `<svg data-value="${value}" width="${width}" height="${height}"></svg>`
      }
    }
  })

  try {
    assert.equal(
      await renderMoleculeSvg('CCO', 120, 80),
      '<svg data-value="CCO" width="120" height="80"></svg>'
    )
  } finally {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow
    })
  }
})
