import assert from 'node:assert/strict'
import test from 'node:test'
import { createTheme, ThemeProvider } from '@mui/material'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { IconType } from 'react-icons'
import { FiExternalLink } from 'react-icons/fi'
import { GoSync } from 'react-icons/go'
import { SiJupyter } from 'react-icons/si'
import { TbFolderOpen, TbListTree } from 'react-icons/tb'
import {
  FILE_TYPE_ICON_META,
  PhiIcons,
  directoryIconForPath,
  fileIconForPath,
  genericDirectoryIcon
} from '../src/renderer/src/icons'

function iconMarkupForPath(path: string): string {
  const { Icon } = fileIconForPath(path)
  return renderToStaticMarkup(createElement(Icon, { fontSize: 'small' }))
}

function iconMarkupForPathWithTheme(path: string, mode: 'dark' | 'light'): string {
  const { Icon } = fileIconForPath(path)
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme({ palette: { mode } }) },
      createElement(Icon, { fontSize: 'small' })
    )
  )
}

function pathDataFromMarkup(markup: string): string[] {
  return Array.from(markup.matchAll(/d="([^"]+)"/g), (match) => match[1])
}

function assertUsesReactIcon(markup: string, ExpectedIcon: IconType): void {
  const expectedMarkup = renderToStaticMarkup(
    createElement(ExpectedIcon, {
      color: 'currentColor',
      focusable: 'false',
      size: '1em',
      strokeWidth: 1.85
    })
  )
  const expectedPaths = pathDataFromMarkup(expectedMarkup)
  const actualPaths = pathDataFromMarkup(markup)

  assert.ok(expectedPaths.length > 0, 'expected react icon should render path data')
  for (const expectedPath of expectedPaths) {
    assert.ok(
      actualPaths.includes(expectedPath),
      `expected rendered icon to include react-icons path data: ${expectedPath}`
    )
  }
}

function assertUsesMaterialIcon(markup: string, iconName: string): void {
  assert.match(markup, new RegExp(`data-phi-material-icon="${iconName}"`))
  assert.match(markup, /<svg /)
  assert.doesNotMatch(markup, /<img /)
  assert.doesNotMatch(markup, /data-phi-missing-material-icon/)
}

function assertMaterialIconForPath(path: string, iconName: string): void {
  const meta = fileIconForPath(path)
  const markup = renderToStaticMarkup(createElement(meta.Icon, { fontSize: 'small' }))

  assert.equal(meta.materialIconName, iconName)
  assertUsesMaterialIcon(markup, iconName)
}

function assertDirectoryMaterialIconForPath(
  path: string,
  iconName: string,
  expanded = false
): void {
  const meta = directoryIconForPath(path, expanded)
  const markup = renderToStaticMarkup(createElement(meta.Icon, { fontSize: 'small' }))

  assert.equal(meta.materialIconName, iconName)
  assertUsesMaterialIcon(markup, iconName)
}

test('generic directory icons never inherit file-like named-folder artwork', () => {
  for (const expanded of [false, true]) {
    const meta = genericDirectoryIcon(expanded)
    assert.equal(meta.kind, 'directory')
    assert.equal(meta.materialIconName, expanded ? 'folder-open' : 'folder')
  }
})

test('fileIconForPath maps common files to representative icon kinds', () => {
  assert.equal(fileIconForPath('/workspace/src/App.tsx').kind, 'react')
  assert.equal(fileIconForPath('/workspace/src/index.ts').kind, 'typescript')
  assert.equal(fileIconForPath('/workspace/src/main.js').kind, 'javascript')
  assert.equal(fileIconForPath('/workspace/scripts/build.py').kind, 'python')
  assert.equal(fileIconForPath('/workspace/scripts/stacked_bar.R').kind, 'r')
  assert.equal(fileIconForPath('/workspace/notebooks/qc.ipynb').kind, 'jupyter')
  assert.equal(fileIconForPath('/workspace/Dockerfile').kind, 'docker')
  assert.equal(fileIconForPath('/workspace/.env.local').kind, 'dotenv')
  assert.equal(fileIconForPath('/workspace/.venv').kind, 'directory')
  assert.equal(fileIconForPath('/workspace/README.md').kind, 'markdown')
  assert.equal(fileIconForPath('/workspace/config.yaml').kind, 'yaml')
  assert.equal(fileIconForPath('/workspace/Cargo.toml').kind, 'toml')
  assert.equal(fileIconForPath('/workspace/package.json').kind, 'json')
  assert.equal(fileIconForPath('/workspace/tsconfig.json').kind, 'config')
  assert.equal(fileIconForPath('/workspace/.python-version').kind, 'config')
  assert.equal(fileIconForPath('/workspace/bun.lock').kind, 'lock')
  assert.equal(fileIconForPath('/workspace/assets/logo.png').kind, 'image')
  assert.equal(fileIconForPath('/workspace/docs/report.pdf').kind, 'pdf')
  assert.equal(fileIconForPath('/workspace/docs/report.docx').kind, 'document')
  assert.equal(fileIconForPath('/workspace/slides/demo.pptx').kind, 'presentation')
  assert.equal(fileIconForPath('/workspace/data/results.xlsm').kind, 'spreadsheet')
  assert.equal(fileIconForPath('/workspace/archive.zip').kind, 'archive')
  assert.equal(fileIconForPath('/workspace/data/results.csv').kind, 'csv')
  assert.equal(fileIconForPath('/workspace/data/results.parquet').kind, 'data')
  assert.equal(fileIconForPath('/workspace/data/variants.vcf').kind, 'data')
  assert.equal(fileIconForPath('/workspace/assets/photo.tiff').kind, 'image')
  assert.equal(fileIconForPath('/workspace/notes.txt').kind, 'text')
  assert.equal(fileIconForPath('/workspace/database.sqlite').kind, 'data')
  assert.equal(fileIconForPath('/workspace/scripts/deploy.sh').kind, 'shell')
  assert.equal(fileIconForPath('/workspace/fonts/inter.woff2').kind, 'type')
})

test('file icons render through the existing Phi icon system', () => {
  for (const meta of Object.values(FILE_TYPE_ICON_META)) {
    const markup = renderToStaticMarkup(createElement(meta.Icon, { fontSize: 'small' }))

    assert.match(markup, /data-phi-material-icon=/)
    assert.match(markup, /<svg /)
    assert.doesNotMatch(markup, /lucide/)
  }
})

test('file icon colors follow recognizable file type colors', () => {
  assert.equal(fileIconForPath('/workspace/scripts/stacked_bar.R').color, '#276DC3')
  assert.equal(fileIconForPath('/workspace/main.py').color, '#3776AB')
  assert.equal(fileIconForPath('/workspace/package.json').color, '#F2C94C')
  assert.equal(fileIconForPath('/workspace/README.md').color, '#6B7280')
  assert.equal(fileIconForPath('/workspace/data/results.csv').color, '#217346')
  assert.equal(fileIconForPath('/workspace/report.xlsx').color, '#217346')
  assert.equal(fileIconForPath('/workspace/report.docx').color, '#01579B')
  assert.equal(fileIconForPath('/workspace/deck.pptx').color, '#E64A19')
})

test('requested file kinds use Material Icon Theme glyphs', () => {
  const jsonMarkup = iconMarkupForPath('/workspace/package.json')
  const csvMarkup = iconMarkupForPath('/workspace/data/results.csv')
  const textMarkup = iconMarkupForPath('/workspace/notes.txt')

  assertUsesMaterialIcon(jsonMarkup, 'nodejs')
  assertUsesMaterialIcon(iconMarkupForPath('/workspace/data.json'), 'json')
  assertUsesMaterialIcon(csvMarkup, 'table')
  assertUsesMaterialIcon(textMarkup, 'document')
  assertUsesMaterialIcon(iconMarkupForPath('/workspace/notebooks/qc.ipynb'), 'jupyter')
  assertUsesMaterialIcon(iconMarkupForPath('/workspace/.env.local'), 'tune')
  assertUsesMaterialIcon(iconMarkupForPath('/workspace/.venv'), 'folder-environment')
  assertUsesMaterialIcon(iconMarkupForPath('/workspace/pyproject.toml'), 'python-misc')
  assertUsesMaterialIcon(iconMarkupForPath('/workspace/uv.lock'), 'uv')
  assertUsesMaterialIcon(iconMarkupForPath('/workspace/report.docx'), 'word')
  assertUsesMaterialIcon(iconMarkupForPath('/workspace/deck.pptx'), 'powerpoint')
  assertUsesMaterialIcon(iconMarkupForPath('/workspace/data/results.xlsm'), 'table')
  assertUsesMaterialIcon(iconMarkupForPath('/workspace/data/results.parquet'), 'database')
  assertUsesMaterialIcon(iconMarkupForPath('/workspace/data/results.sas7bdat'), 'sas')
  assertUsesMaterialIcon(iconMarkupForPath('/workspace/certs/server.crt'), 'certificate')
  assertUsesMaterialIcon(
    iconMarkupForPathWithTheme('/workspace/design/mockup.psd', 'dark'),
    'adobe-photoshop'
  )
})

test('material svg icons preserve root fill so README does not render a dark backdrop', () => {
  const markup = iconMarkupForPath('/workspace/README.md')

  assertUsesMaterialIcon(markup, 'readme')
  assert.match(markup, /<g fill="none">/)
})

test('material svg icons switch to light assets when Material Icon Theme provides one', () => {
  const darkMarkup = iconMarkupForPathWithTheme('/workspace/config.toml', 'dark')
  const lightMarkup = iconMarkupForPathWithTheme('/workspace/config.toml', 'light')

  assertUsesMaterialIcon(darkMarkup, 'toml')
  assertUsesMaterialIcon(lightMarkup, 'toml_light')
})

test('screenshot sample files resolve to concrete Material Icon Theme assets', () => {
  assertMaterialIconForPath('/workspace/test/stacked_bar.png', 'image')
  assertMaterialIconForPath('/workspace/test/stacked_bar.R', 'r')
  assertMaterialIconForPath('/workspace/test/palette_swatches.R', 'r')
  assertMaterialIconForPath('/workspace/test/qc-demo.csv', 'table')
  assertMaterialIconForPath('/workspace/test/use_data.json', 'json')
  assertMaterialIconForPath('/workspace/test/main.py', 'python')
  assertMaterialIconForPath('/workspace/test/test.py', 'python')
  assertMaterialIconForPath('/workspace/test/README.md', 'readme')
  assertMaterialIconForPath('/workspace/test/.venv', 'folder-environment')
  assertMaterialIconForPath('/workspace/test/notebook.ipynb', 'jupyter')
  assertMaterialIconForPath('/workspace/test/商铺.pptx', 'powerpoint')
  assertMaterialIconForPath('/workspace/test/厦门大学博士.docx', 'word')

  const folder = directoryIconForPath('/workspace/test')
  const folderMarkup = renderToStaticMarkup(createElement(folder.Icon, { fontSize: 'small' }))
  assert.equal(folder.materialIconName, 'folder-test')
  assertUsesMaterialIcon(folderMarkup, 'folder-test')
})

test('workspace tree special paths resolve to VS Code style Material icons', () => {
  const rootFolder = directoryIconForPath('/workspace/test', true, true)
  const rootMarkup = renderToStaticMarkup(createElement(rootFolder.Icon, { fontSize: 'small' }))
  assert.equal(rootFolder.materialIconName, 'folder-root-open')
  assertUsesMaterialIcon(rootMarkup, 'folder-root-open')

  const gitFolder = directoryIconForPath('/workspace/test/.git')
  const gitFolderMarkup = renderToStaticMarkup(createElement(gitFolder.Icon, { fontSize: 'small' }))
  assert.equal(gitFolder.materialIconName, 'folder-git')
  assertUsesMaterialIcon(gitFolderMarkup, 'folder-git')

  const venvFolder = directoryIconForPath('/workspace/test/.venv')
  const venvFolderMarkup = renderToStaticMarkup(
    createElement(venvFolder.Icon, { fontSize: 'small' })
  )
  assert.equal(venvFolder.materialIconName, 'folder-environment')
  assertUsesMaterialIcon(venvFolderMarkup, 'folder-environment')

  for (const [path, iconName, expandedIconName] of [
    ['/workspace/test/bin', 'folder-dist', 'folder-dist-open'],
    ['/workspace/test/build', 'folder-dist', 'folder-dist-open'],
    ['/workspace/test/dist', 'folder-dist', 'folder-dist-open'],
    ['/workspace/test/include', 'folder-include', 'folder-include-open'],
    ['/workspace/test/lib', 'folder-lib', 'folder-lib-open'],
    ['/workspace/test/log', 'folder-log', 'folder-log-open'],
    ['/workspace/test/logs', 'folder-log', 'folder-log-open'],
    ['/workspace/test/scripts', 'folder-scripts', 'folder-scripts-open'],
    ['/workspace/test/src', 'folder-src', 'folder-src-open']
  ] as const) {
    assertDirectoryMaterialIconForPath(path, iconName)
    assertDirectoryMaterialIconForPath(path, expandedIconName, true)
  }

  assertMaterialIconForPath('/workspace/test/.gitignore', 'git')
})

test('file icons render Material Icon Theme assets as inline React icon components', () => {
  for (const path of [
    '/workspace/package.json',
    '/workspace/data/results.csv',
    '/workspace/notes.txt',
    '/workspace/main.py',
    '/workspace/scripts/stacked_bar.R',
    '/workspace/archive.zip'
  ]) {
    const markup = iconMarkupForPath(path)
    assert.match(markup, /data-phi-material-icon=/)
    assert.match(markup, /<svg /)
    assert.doesNotMatch(markup, /<img /)
    assert.doesNotMatch(markup, /transform:scale/)
  }
})

test('directory and preview controls expose stable icon semantics', () => {
  const folderMarkup = renderToStaticMarkup(
    createElement(PhiIcons.entity.folder, { fontSize: 'small' })
  )
  const directoryMarkup = renderToStaticMarkup(
    createElement(directoryIconForPath('/workspace/test').Icon)
  )
  const directoryOpenMarkup = renderToStaticMarkup(
    createElement(directoryIconForPath('/workspace/test', true).Icon)
  )
  const treeMarkup = renderToStaticMarkup(
    createElement(PhiIcons.entity.directoryTree, { fontSize: 'small' })
  )
  const openMarkup = renderToStaticMarkup(
    createElement(PhiIcons.action.openDefault, { fontSize: 'small' })
  )

  assertUsesReactIcon(folderMarkup, TbFolderOpen)
  assertUsesMaterialIcon(directoryMarkup, 'folder-test')
  assertUsesMaterialIcon(directoryOpenMarkup, 'folder-test-open')
  assertUsesReactIcon(treeMarkup, TbListTree)
  assertUsesReactIcon(openMarkup, FiExternalLink)
  assert.equal(FILE_TYPE_ICON_META.directory.kind, 'directory')
})

test('auto permission icon is visually balanced with other permission icons', () => {
  const markup = renderToStaticMarkup(createElement(PhiIcons.state.auto, { fontSize: 'small' }))

  assert.match(markup, /transform:scale\(1\.16\)/)
})

test('refresh icon keeps the native GoSync stroke weight', () => {
  const native = renderToStaticMarkup(createElement(GoSync))
  const refresh = renderToStaticMarkup(createElement(PhiIcons.action.refresh))

  assert.match(refresh, /stroke-width="0"/)
  assert.equal(refresh.match(/<path d="([^"]+)"/)?.[1], native.match(/<path d="([^"]+)"/)?.[1])
})

test('language file icon kinds render non-empty icons', () => {
  const rMarkup = iconMarkupForPath('/workspace/scripts/stacked_bar.R')
  const pythonMarkup = iconMarkupForPath('/workspace/main.py')

  for (const markup of [rMarkup, pythonMarkup]) {
    assert.match(markup, /<svg /)
    assert.doesNotMatch(markup, /<img /)
    assert.doesNotMatch(markup, /lucide/)
  }
  assertUsesMaterialIcon(rMarkup, 'r')
  assertUsesMaterialIcon(pythonMarkup, 'python')
  assert.equal(fileIconForPath('/workspace/main.py').materialIconName, 'python')
  assert.equal(fileIconForPath('/workspace/scripts/stacked_bar.R').materialIconName, 'r')
})

test('the left activity bar "运行时" nav icon reads as Jupyter, not a generic notebook glyph', () => {
  // The runtime nav entry (left sidebar, below the project icon) always
  // points at the app-managed Jupyter Server -- it should carry Jupyter's
  // own mark like the other brand-specific nav/file icons do, not a
  // generic TbNotebook glyph that could be any notebook app.
  const markup = renderToStaticMarkup(createElement(PhiIcons.nav.runtime, { fontSize: 'small' }))
  assertUsesReactIcon(markup, SiJupyter)
})
