import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { setUiLanguage } from '../src/renderer/src/lib/i18n'
import { wrapperCopy } from '../src/renderer/src/features/wrapper/lib/wrapperCopy'
import { FileTreeRootRow } from '../src/renderer/src/features/file-preview/components/FileTreeRootRow'
import { FileTreeRow } from '../src/renderer/src/features/file-preview/components/FileTreeRow'

test('remote file-tree directory rows expose exact local-file drop destinations', () => {
  const directory = renderToStaticMarkup(
    createElement(FileTreeRow, {
      entry: {
        name: 'reads',
        path: 'ssh://cluster/data/project/reads',
        displayPath: '/data/project/reads',
        kind: 'directory'
      },
      depth: 1,
      isExpanded: false,
      isActive: false,
      localDropTargetPath: 'ssh://cluster/data/project/reads',
      onClick: () => undefined
    })
  )
  assert.match(directory, /data-phi-file-drop-target="remote-file-tree"/)
  assert.match(directory, /data-phi-file-drop-path="ssh:\/\/cluster\/data\/project\/reads"/)

  const root = renderToStaticMarkup(
    createElement(FileTreeRootRow, {
      rootPath: 'ssh://cluster/data/project',
      rootName: 'project',
      rootDisplayPath: '/data/project',
      isExpanded: true,
      isActive: true,
      localDropTargetPath: 'ssh://cluster/data/project',
      onToggle: () => undefined
    })
  )
  assert.match(root, /data-phi-file-drop-target="remote-file-tree"/)
})

test('Wrapper input upload is a feature-private dialog and targeted drop surface', () => {
  const card = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/features/wrapper/components/WrapperPlanCard.tsx'),
    'utf8'
  )
  const dialog = readFileSync(
    resolve(
      process.cwd(),
      'src/renderer/src/features/wrapper/components/WrapperInputUploadDialog.tsx'
    ),
    'utf8'
  )
  assert.match(card, /<WrapperInputUploadDialog/)
  assert.match(card, /projectLocation\.kind === 'ssh'/)
  assert.match(dialog, /data-phi-file-drop-target="wrapper-input"/)
  assert.match(dialog, /completeWrapperInputUpload/)
  assert.match(dialog, /wrapperCopy\.cancelUpload/)
  setUiLanguage('en')
  assert.equal(wrapperCopy.cancelUpload, 'Cancel upload')
  setUiLanguage('zh-CN')
  assert.equal(wrapperCopy.cancelUpload, '取消上传')
  setUiLanguage('en')
})
