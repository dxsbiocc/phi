import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { FILE_TYPE_ICON_META, PhiIcons, fileIconForPath } from '../src/renderer/src/icons'

function iconMarkupForPath(path: string): string {
  const { Icon } = fileIconForPath(path)
  return renderToStaticMarkup(createElement(Icon, { fontSize: 'small' }))
}

test('fileIconForPath maps common files to representative icon kinds', () => {
  assert.equal(fileIconForPath('/workspace/src/App.tsx').kind, 'react')
  assert.equal(fileIconForPath('/workspace/src/index.ts').kind, 'typescript')
  assert.equal(fileIconForPath('/workspace/src/main.js').kind, 'javascript')
  assert.equal(fileIconForPath('/workspace/scripts/build.py').kind, 'python')
  assert.equal(fileIconForPath('/workspace/scripts/stacked_bar.R').kind, 'r')
  assert.equal(fileIconForPath('/workspace/notebooks/qc.ipynb').kind, 'jupyter')
  assert.equal(fileIconForPath('/workspace/Dockerfile').kind, 'docker')
  assert.equal(fileIconForPath('/workspace/.env.local').kind, 'dotenv')
  assert.equal(fileIconForPath('/workspace/.venv').kind, 'text')
  assert.equal(fileIconForPath('/workspace/README.md').kind, 'markdown')
  assert.equal(fileIconForPath('/workspace/config.yaml').kind, 'yaml')
  assert.equal(fileIconForPath('/workspace/Cargo.toml').kind, 'toml')
  assert.equal(fileIconForPath('/workspace/package.json').kind, 'json')
  assert.equal(fileIconForPath('/workspace/tsconfig.json').kind, 'config')
  assert.equal(fileIconForPath('/workspace/.python-version').kind, 'config')
  assert.equal(fileIconForPath('/workspace/bun.lock').kind, 'lock')
  assert.equal(fileIconForPath('/workspace/assets/logo.png').kind, 'image')
  assert.equal(fileIconForPath('/workspace/docs/report.pdf').kind, 'pdf')
  assert.equal(fileIconForPath('/workspace/archive.zip').kind, 'archive')
  assert.equal(fileIconForPath('/workspace/data/results.csv').kind, 'spreadsheet')
  assert.equal(fileIconForPath('/workspace/database.sqlite').kind, 'data')
  assert.equal(fileIconForPath('/workspace/scripts/deploy.sh').kind, 'shell')
  assert.equal(fileIconForPath('/workspace/fonts/inter.woff2').kind, 'type')
})

test('file icons render through the existing Phi icon system', () => {
  for (const meta of Object.values(FILE_TYPE_ICON_META)) {
    const markup = renderToStaticMarkup(createElement(meta.Icon, { fontSize: 'small' }))

    assert.match(markup, /viewBox="0 0 24 24"/)
    assert.match(markup, /class="lucide /)
    assert.doesNotMatch(markup, /react-icons/)
  }
})

test('directory and preview controls expose stable icon semantics', () => {
  const folderMarkup = renderToStaticMarkup(
    createElement(PhiIcons.entity.folder, { fontSize: 'small' })
  )
  const directoryMarkup = renderToStaticMarkup(
    createElement(FILE_TYPE_ICON_META.directory.Icon, { fontSize: 'small' })
  )
  const treeMarkup = renderToStaticMarkup(
    createElement(PhiIcons.entity.directoryTree, { fontSize: 'small' })
  )
  const openMarkup = renderToStaticMarkup(
    createElement(PhiIcons.action.openDefault, { fontSize: 'small' })
  )

  assert.match(folderMarkup, /lucide-folder/)
  assert.match(directoryMarkup, /lucide-folder/)
  assert.match(treeMarkup, /lucide-folder-open/)
  assert.match(openMarkup, /lucide-external-link/)
  assert.equal(FILE_TYPE_ICON_META.directory.kind, 'directory')
})

test('language file icon kinds render non-empty icons', () => {
  for (const path of ['/workspace/scripts/stacked_bar.R', '/workspace/main.py']) {
    const markup = iconMarkupForPath(path)

    assert.match(markup, /<svg /)
    assert.match(markup, /class="lucide /)
  }
})
