import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { parse as parseYaml } from 'yaml'

import { buildPaletteRecommendationTool } from '../src/main/agent/palettes/tools'
import { getBundledPalettesDir } from '../src/main/agent/runtime/runtime-adapter'

type PaletteResult = {
  kind: string
  palettes: Array<{ id: string; kind: string; colors: string[]; use_when: string }>
}

test('Phi owns one shared palette catalog outside the visualization skill', () => {
  const paletteDir = getBundledPalettesDir()
  const index = parseYaml(readFileSync(join(paletteDir, 'palettes.yaml'), 'utf8')) as {
    source: string
    recommended: Array<{ id: string; colors: string[] }>
  }
  const colors = JSON.parse(readFileSync(join(paletteDir, index.source), 'utf8')) as {
    Qualitative: { Safe: string[] }
  }

  assert.deepEqual(
    index.recommended.find((palette) => palette.id === 'Qualitative.Safe')?.colors,
    colors.Qualitative.Safe
  )
  assert.equal(
    existsSync(
      join(process.cwd(), 'resources/skills/omics-visualization/references/palettes.yaml')
    ),
    false
  )
})

test('main agent can suggest named palettes from the bundled catalog', async () => {
  const tool = buildPaletteRecommendationTool()
  assert.equal(tool.name, 'palette_suggest')
  assert.equal(tool.approval, 'read')

  const result = await tool.execute('call-1', { use: 'categorical' }, undefined, {} as never)
  assert.equal(result.isError, undefined)
  const details = result.details as PaletteResult
  assert.equal(details.kind, 'palette_suggestions')
  assert.equal(details.palettes[0]?.id, 'Qualitative.Safe')
  assert.equal(details.palettes.length, 3)
  assert.ok(details.palettes[0].colors.every((color) => /^#[0-9a-f]{6}$/i.test(color)))
  assert.ok(details.palettes[0].use_when)
})

test('palette suggestions follow the encoding and exact palette ID', async () => {
  const tool = buildPaletteRecommendationTool()
  const heatmap = await tool.execute('call-1', { use: 'heatmap', limit: 1 }, undefined, {} as never)
  const diverging = await tool.execute('call-2', { use: 'diverging' }, undefined, {} as never)
  const exact = await tool.execute('call-3', { id: 'brand.algolia' }, undefined, {} as never)
  const product = await tool.execute('call-4', { use: 'product', limit: 1 }, undefined, {} as never)
  const warm = await tool.execute('call-5', { use: 'sequential_warm' }, undefined, {} as never)

  assert.deepEqual(
    (heatmap.details as PaletteResult).palettes.map((palette) => palette.id),
    ['Quantitative.BluGrn']
  )
  assert.equal((diverging.details as PaletteResult).palettes[0]?.id, 'Diverging.RdBu')
  assert.equal((exact.details as PaletteResult).palettes[0]?.id, 'Brand.Algolia')
  assert.equal((product.details as PaletteResult).palettes[0]?.id, 'Brand.Algolia')
  assert.deepEqual(
    (warm.details as PaletteResult).palettes.map((palette) => palette.id),
    ['Gradient.YlOrRd', 'Quantitative.Sunset']
  )
})

test('palette tool reports invalid requests and missing catalogs', async () => {
  const tool = buildPaletteRecommendationTool()
  const invalid = await tool.execute('call-1', { use: 'unknown' }, undefined, {} as never)
  const missingId = await tool.execute('call-2', { id: 'Unknown.Palette' }, undefined, {} as never)
  const missingCatalog = await buildPaletteRecommendationTool('/missing/palettes.yaml').execute(
    'call-3',
    {},
    undefined,
    {} as never
  )

  assert.equal(invalid.isError, true)
  assert.equal(missingId.isError, true)
  assert.equal(missingCatalog.isError, true)
})
