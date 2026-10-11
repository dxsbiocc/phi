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
    '输入',
    '选项',
    '输出',
    '范围：1 – 8',
    '关于',
    'Sort BAM files',
    'MIT',
    '环境',
    'channels'
  ]) {
    assert.ok(markup.includes(text), `missing: ${text}`)
  }
  assert.ok(!markup.includes('运行记录'))
})

test('page-specific slots render in order around the shared sections', () => {
  const markup = render({
    identityExtras: createElement('span', null, 'IDENTITY-EXTRA'),
    afterIdentity: createElement('p', null, 'AFTER-IDENTITY'),
    children: createElement('p', null, 'RUN-HISTORY')
  })
  const order = ['IDENTITY-EXTRA', 'AFTER-IDENTITY', '输入', '关于', '环境', 'RUN-HISTORY']
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
  const tier = markup.indexOf('模块')
  const extra = markup.indexOf('EXTRA-V1')
  assert.ok(tier >= 0 && extra > tier)
  assert.ok(extra < markup.indexOf('输入'))
})
