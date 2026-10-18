import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material/styles'

import type { WrapperCompositionManifest } from '../src/shared/wrapperCompositionManifestTypes'
import type { WrapperModuleDetails } from '../src/shared/wrapperModuleDetailsTypes'
import { WrapperDetailBody } from '../src/renderer/src/features/wrapper/components/WrapperDetailBody'

const manifest: WrapperCompositionManifest = {
  id: 'nf-core/modules/samtools-sort',
  name: 'samtools sort',
  summary: 'Sort a BAM file',
  params: {
    bam: { kind: 'input', type: 'file', required: true, description: 'BAM to sort' },
    threads: { kind: 'option', type: 'integer', required: false, minimum: 1, maximum: 8 }
  },
  outputs: { bam: { type: 'file', path: '${outdir}/sorted.bam', primary: true } }
}

const details: WrapperModuleDetails = {
  meta: {
    description: 'Sort BAM files',
    keywords: ['sort'],
    tools: [{ name: 'samtools', licence: ['MIT'], homepage: 'http://www.htslib.org/' }],
    authors: ['@alice']
  },
  environment: 'channels:\n  - conda-forge\n'
}

function render(extra: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(WrapperDetailBody, {
        manifest,
        graph: undefined,
        moduleDetails: details,
        ...extra
      })
    )
  )
}

test('the shared body shows identity, contract, module metadata and environment', () => {
  const markup = render()
  for (const text of [
    'samtools sort',
    'nf-core/modules/samtools-sort',
    'Inputs',
    'Options',
    'Outputs',
    'Range: 1 – 8',
    'About',
    'Sort BAM files',
    'MIT',
    'Environment',
    'channels'
  ]) {
    assert.ok(markup.includes(text), `missing: ${text}`)
  }
  assert.ok(!markup.includes('Run History'))
})

test('English management labels preserve the author-provided title, description and authors', () => {
  const markup = render({
    manifest: { ...manifest, name: '排序工具', summary: '作者提供的说明' },
    moduleDetails: { ...details, meta: { ...details.meta, authors: ['张三', '@alice'] } }
  })
  assert.match(markup, /排序工具/)
  assert.match(markup, /作者提供的说明/)
  assert.match(markup, /Authors: 张三, @alice/)
  assert.match(markup, /Inputs/)
  assert.match(markup, /nf-core\/modules\/samtools-sort/)
})

test('page-specific slots render in order around the shared sections', () => {
  const markup = render({
    identityExtras: createElement('span', null, 'IDENTITY-EXTRA'),
    afterIdentity: createElement('p', null, 'AFTER-IDENTITY'),
    children: createElement('p', null, 'RUN-HISTORY')
  })
  const order = [
    'IDENTITY-EXTRA',
    'AFTER-IDENTITY',
    'Inputs',
    'About',
    'Environment',
    'RUN-HISTORY'
  ]
  const positions = order.map((text) => markup.indexOf(text))
  assert.ok(
    positions.every((position) => position >= 0),
    'every slot renders'
  )
  assert.deepEqual(
    [...positions].sort((a, b) => a - b),
    positions
  )
})

test('extra chips join the provider and tier chips in the identity block', () => {
  const markup = render({ extraChips: createElement('span', null, 'EXTRA-V1') })
  const tier = markup.indexOf('Modules')
  const extra = markup.indexOf('EXTRA-V1')
  assert.ok(tier >= 0 && extra > tier)
  assert.ok(extra < markup.indexOf('Inputs'))
})
