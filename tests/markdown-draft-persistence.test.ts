import assert from 'node:assert/strict'
import test from 'node:test'

import {
  loadTextFileDrafts,
  TEXT_FILE_DRAFT_STORAGE_KEY,
  saveTextFileDrafts
} from '../src/renderer/src/features/file-preview/lib/textFileDraftPersistence'
import type { TextFileDraft } from '../src/renderer/src/features/file-preview/lib/textFileDrafts'
import { WORKSPACE_TEXT_MAX_BYTES } from '../src/shared/workspaceFileOperations'

function draft(content = '# Edited\n'): TextFileDraft {
  return { baseContent: '# Before\n', content, saving: false, error: null }
}

function storage(): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    }
  }
}

test('Text file drafts survive restart for local and remote files with fresh transient state', () => {
  const state = storage()
  const local = draft('## 草稿\n正文\n')
  const remote = { ...draft(), saving: true, error: 'old save error' }
  saveTextFileDrafts(state, {
    '/project/notes.md': local,
    'ssh://cluster/project/notes.markdown': remote,
    '/project/unchanged.mdown': draft('# Before\r\n')
  })
  assert.deepEqual(loadTextFileDrafts(state), {
    '/project/notes.md': local,
    'ssh://cluster/project/notes.markdown': { ...remote, saving: false, error: null }
  })
  assert.ok(state.getItem(TEXT_FILE_DRAFT_STORAGE_KEY))
})

test('saved, discarded and released drafts disappear from durable recovery', () => {
  const state = storage()
  saveTextFileDrafts(state, { '/project/notes.md': draft() })
  assert.equal(Object.keys(loadTextFileDrafts(state)).length, 1)
  saveTextFileDrafts(state, { '/project/notes.md': draft('# Before\n') })
  assert.deepEqual(loadTextFileDrafts(state), {})
  saveTextFileDrafts(state, { '/project/notes.md': { ...draft('# Before\n'), saving: true } })
  assert.equal(loadTextFileDrafts(state)['/project/notes.md'].saving, false)
  saveTextFileDrafts(state, {})
  assert.deepEqual(loadTextFileDrafts(state), {})
})

test('draft recovery skips malformed, unsafe, non-UTF-8 and oversized entries', () => {
  const state = storage()
  const tooLarge = '你'.repeat(Math.ceil(WORKSPACE_TEXT_MAX_BYTES / 3))
  const records: Record<string, unknown> = {
    '/project/good.md': draft(),
    'ssh://cluster/project/good.MDOWN': draft(),
    '/project/good.txt': draft(),
    '/project/.gitignore': draft(),
    'relative.md': draft(),
    '/project/../outside.md': draft(),
    'https://example.com/note.md': draft(),
    'ssh:///project/note.md': draft(),
    'ssh://cluster/project/note.md?secret=x': draft(),
    'ssh://cluster/project/%2e%2e/outside.md': draft(),
    '/project/surrogate.md': draft('\ud800'),
    '/project/binary.md': draft('\0binary'),
    '/project/large.md': draft(tooLarge),
    '/project/large-source.md': { ...draft(), baseContent: tooLarge },
    '/project/array.md': [],
    '/project/null.md': null,
    '/project/invalid.md': { baseContent: 1, content: 'string' }
  }
  state.setItem(TEXT_FILE_DRAFT_STORAGE_KEY, JSON.stringify(records))
  assert.deepEqual(Object.keys(loadTextFileDrafts(state)), [
    '/project/good.md',
    'ssh://cluster/project/good.MDOWN',
    '/project/good.txt',
    '/project/.gitignore'
  ])
  const exact = draft('x'.repeat(WORKSPACE_TEXT_MAX_BYTES))
  saveTextFileDrafts(state, { '/project/max.md': exact, '/project/large.md': draft(tooLarge) })
  assert.deepEqual(loadTextFileDrafts(state), { '/project/max.md': exact })
})

test('missing or malformed draft JSON recovers empty and storage failures are surfaced', () => {
  const state = storage()
  assert.deepEqual(loadTextFileDrafts(state), {})
  for (const raw of ['{', 'null', '[]', '"string"']) {
    state.setItem(TEXT_FILE_DRAFT_STORAGE_KEY, raw)
    assert.deepEqual(loadTextFileDrafts(state), {})
  }
  assert.throws(
    () =>
      loadTextFileDrafts({
        getItem: () => {
          throw new Error('denied')
        }
      }),
    /无法读取本地文本草稿/
  )
  assert.throws(
    () =>
      saveTextFileDrafts(
        {
          setItem: () => {
            throw new Error('quota')
          }
        },
        { '/project/notes.md': draft() }
      ),
    /无法保存本地文本草稿.*存储空间/
  )
})

test('text drafts recover existing Markdown storage without resurrecting cleared edits', () => {
  const state = storage()
  state.setItem('phi.markdown-drafts.v1', JSON.stringify({ '/project/notes.md': draft() }))
  assert.deepEqual(loadTextFileDrafts(state), { '/project/notes.md': draft() })
  saveTextFileDrafts(state, {})
  assert.deepEqual(loadTextFileDrafts(state), {})
})
