import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import test from 'node:test'

import { createLocalFilePreviews } from '../src/main/local-file-previews'
import { WORKSPACE_TEXT_MAX_BYTES } from '../src/shared/workspaceFileOperations'

function previewsFor(root: string): ReturnType<typeof createLocalFilePreviews> {
  return createLocalFilePreviews({
    assertLocalFilePathAllowed: (filePath: string): string => filePath,
    assertFileHoverPreviewPathAllowed: (filePath: string): string => filePath,
    getLocalPathScope: (target: string) => ({
      rootPath: root,
      rootLabel: 'project',
      displayPath: relative(root, target)
    })
  })
}

type TextPreview = Extract<
  ReturnType<ReturnType<typeof createLocalFilePreviews>['createFilePreview']>,
  { kind: 'text' }
>

function textPreview(
  previews: ReturnType<typeof createLocalFilePreviews>,
  path: string
): TextPreview {
  const preview = previews.createFilePreview(path)
  if (preview.kind !== 'text') throw new Error(`expected a text preview, got ${preview.kind}`)
  return preview
}

test('local text previews flag invalid UTF-8 and accept a multibyte truncation boundary', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-local-file-previews-'))
  try {
    const previews = previewsFor(root)

    const invalidPath = join(root, 'invalid.txt')
    writeFileSync(invalidPath, Buffer.from([0x41, 0xff, 0x42]))
    const invalid = textPreview(previews, invalidPath)
    assert.equal(invalid.invalidUtf8, true)
    assert.equal(invalid.truncated, false)

    const validPath = join(root, 'valid.txt')
    writeFileSync(validPath, 'héllo 世界\n', 'utf8')
    const valid = textPreview(previews, validPath)
    assert.equal(valid.invalidUtf8, false)
    assert.equal(valid.content, 'héllo 世界\n')

    const splitPath = join(root, 'split.txt')
    writeFileSync(
      splitPath,
      Buffer.concat([
        Buffer.alloc(WORKSPACE_TEXT_MAX_BYTES - 2, 'a'),
        Buffer.from('😀'),
        Buffer.from('tail')
      ])
    )
    const split = textPreview(previews, splitPath)
    assert.equal(split.truncated, true)
    assert.equal(split.previewBytes, WORKSPACE_TEXT_MAX_BYTES)
    assert.equal(split.invalidUtf8, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
