import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeMoleculeSvgRenderInput, renderMoleculeSvg } from '../src/main/molecule-renderer'

test('main process RDKit renderer returns SVG for SMILES input', async () => {
  const svg = await renderMoleculeSvg('NC(Cc1cc(I)c(Oc2ccc(O)c(I)c2)c(I)c1)C(=O)O', 180, 120)

  assert.match(svg, /<svg\b/)
  assert.match(svg, /width='180px'/)
  assert.match(svg, /height='120px'/)
})

test('molecule render input normalization trims value and clamps dimensions', () => {
  assert.deepEqual(normalizeMoleculeSvgRenderInput(' CCO ', 12, 1000), {
    value: 'CCO',
    width: 64,
    height: 800
  })
})
