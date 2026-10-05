import assert from 'node:assert/strict'
import test from 'node:test'

import { defaultAppIconMode } from '../src/renderer/src/features/file-preview/lib/filePreviewState'

test('Office draft files use extension icons without requesting a path-based system icon', () => {
  for (const path of [
    '/phi/sessions/session-1/artifacts/office/artifact-1/report.xlsx',
    '/phi/sessions/session-1/artifacts/office/artifact-1/report.DOCX',
    String.raw`C:\phi\sessions\session-1\artifacts\office\artifact-1\slides.pptx`
  ]) {
    assert.equal(defaultAppIconMode(path, 'file'), 'extension')
  }
})

test('ordinary files and non-files keep the existing native icon lookup', () => {
  assert.equal(defaultAppIconMode('/project/report.xlsx', 'file'), 'native')
  assert.equal(
    defaultAppIconMode('/phi/sessions/session-1/artifacts/office/artifact-1/readme.txt', 'file'),
    'native'
  )
  assert.equal(
    defaultAppIconMode('/phi/sessions/session-1/artifacts/office/artifact-1', 'directory'),
    'native'
  )
})
