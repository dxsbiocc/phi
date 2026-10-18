import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material/styles'

import { SkillDetailBody } from '../src/renderer/src/features/skill/components/SkillDetailBody'
import { SkillPackageDetailPage } from '../src/renderer/src/features/skill/components/SkillPackageDetailPage'
import type { SkillCatalogPackage } from '../src/renderer/src/features/skill/lib/skillCatalogBrowser'

const themed = (element: React.ReactElement): string =>
  renderToStaticMarkup(createElement(ThemeProvider, { theme: createTheme() }, element))

const base = {
  name: 'anndata',
  enabled: true,
  sourceLabel: '软件包',
  description: 'Annotated matrices',
  sourceText: '软件包 · Phi Packages',
  markdown: { content: '# Hello\n\nbody', isLoading: false, error: null }
}

test('the skill body shows description, source and the SKILL.md text', () => {
  const markup = themed(createElement(SkillDetailBody, base))
  for (const text of [
    'anndata',
    'Description',
    'Annotated matrices',
    'Source',
    'Phi Packages',
    'SKILL.md',
    'Hello'
  ]) {
    assert.ok(markup.includes(text), `missing: ${text}`)
  }
  assert.ok(!markup.includes('File'))
})

test('the folder section appears only for a skill that is on disk', () => {
  const markup = themed(
    createElement(SkillDetailBody, { ...base, location: '/skills/anndata/SKILL.md' })
  )
  assert.ok(markup.includes('File'))
  assert.ok(markup.includes('/skills/anndata/SKILL.md'))
})

test('loading and failed SKILL.md reads are stated, not blank', () => {
  assert.ok(
    themed(
      createElement(SkillDetailBody, {
        ...base,
        markdown: { content: null, isLoading: true, error: null }
      })
    ).includes('Loading SKILL.md')
  )
  assert.ok(
    themed(
      createElement(SkillDetailBody, {
        ...base,
        markdown: { content: null, isLoading: false, error: '读取失败 x' }
      })
    ).includes('读取失败 x')
  )
})

test('the catalog preview keeps identity and every chip in the content, not the top bar', () => {
  const entry: SkillCatalogPackage = {
    id: 'anndata',
    type: 'skill',
    version: '1.0.0',
    title: 'anndata',
    summary: 'Annotated matrices',
    archive: 'a.tar.gz',
    sha256: 'a'.repeat(64),
    size: 19 * 1024,
    dependsOn: [],
    registryDir: '/registry',
    registryLabel: 'Phi Packages'
  }
  const markup = themed(
    createElement(SkillPackageDetailPage, {
      entry,
      installed: false,
      action: createElement('button', null, 'ACTION-SLOT'),
      onBack: () => undefined
    })
  )
  for (const text of [
    'Back to skill catalog',
    'anndata',
    'v1.0.0',
    '19 KB',
    'Phi Packages',
    'Not installed',
    'Description',
    'ACTION-SLOT'
  ]) {
    assert.ok(markup.includes(text), `missing: ${text}`)
  }
  // The name appears once (in the content header); the top bar no longer repeats it.
  assert.equal(markup.match(/>anndata</g)?.length, 1)
  // Version, size and status chips sit together in one row.
  const chipRow = markup.slice(markup.indexOf('v1.0.0') - 400, markup.indexOf('Not installed') + 20)
  assert.ok(chipRow.includes('19 KB') && chipRow.includes('Phi Packages'))
})
