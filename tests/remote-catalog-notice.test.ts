import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'

import { CatalogSidebar } from '../src/renderer/src/components/CatalogSidebar'

test('remote resource notice stays inside the catalog, below its title and search', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(
        CatalogSidebar,
        {
          title: '技能',
          resource: 'skills',
          query: '',
          onQueryChange: () => undefined,
          searchPlaceholder: '搜索技能',
          summary: '9 个技能',
          notice: '远程项目级 Skills 暂未接通；当前仅显示全局 Skills。'
        },
        createElement('div', { 'data-testid': 'catalog-list' })
      )
    )
  )

  const title = markup.indexOf('>技能</')
  const search = markup.indexOf('aria-label="搜索技能"')
  const notice = markup.indexOf('data-phi-catalog-notice="skills"')
  const list = markup.indexOf('data-testid="catalog-list"')

  assert.ok(title >= 0 && title < search && search < notice && notice < list)
  assert.match(markup, /远程项目级 Skills 暂未接通/)
})
