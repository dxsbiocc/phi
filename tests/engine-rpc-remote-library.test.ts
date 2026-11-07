import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { libraryNoteMarkdown, listPapers } from '../src/main/agent/library/library-store'
import type { SavedPaper } from '../src/main/agent/library/library-types'
import { RemoteLibraryStorage } from '../src/main/agent/engine/rpc/remote-library-storage'
import { rpcRemoteLibraryFixture } from './helpers/rpcRemoteLibraryFixture'
function details(value: { details?: unknown }): Record<string, unknown> {
  assert.ok(value.details && typeof value.details === 'object')
  return value.details as Record<string, unknown>
}

test(
  'real remote library tools CRUD/dedup/filters/audit preserve metadata/note/index and reopen without local-anchor IO',
  { timeout: 60000 },
  async (t) => {
    const f = rpcRemoteLibraryFixture()
    t.after(() => f.close())
    const missing = await f.call('lib_list')
    assert.equal(missing.isError, undefined, JSON.stringify(missing))
    assert.deepEqual(details(missing).papers, [])
    assert.equal(existsSync(join(f.server.projectRoot, '.phi')), false)
    const first = await f.call('lib_save', {
      source: 'pubmed',
      sourceId: '123',
      title: 'Alpha—Beta Response',
      doi: 'https://doi.org/10.1000/Example',
      authors: ['A'],
      notes: 'Original notes',
      tags: ['methods']
    })
    assert.equal(first.isError, undefined, JSON.stringify(first))
    const paper = details(first).paper as SavedPaper
    assert.equal(paper.canonicalId, 'doi:10.1000/example')
    const merged = await f.call('lib_save', {
      source: 'arxiv',
      id: '777',
      title: 'Alpha-Beta  Response',
      doi: '10.2000/alias',
      authors: ['B']
    })
    assert.equal(merged.isError, undefined, JSON.stringify(merged))
    const updated = details(merged).paper as SavedPaper
    assert.equal(updated.canonicalId, paper.canonicalId)
    assert.equal(updated.revision, 2)
    assert.ok(updated.aliases.includes('doi:10.2000/alias'))
    const patched = await f.call('lib_update', {
      id: '123',
      notes: 'Read deeply',
      processingStage: 'deep_read'
    })
    assert.equal(patched.isError, undefined, JSON.stringify(patched))
    const current = JSON.parse(JSON.stringify(details(patched).paper)) as SavedPaper
    assert.equal(current.revision, 3)
    const found = await f.call('lib_find', { query: 'deeply', tags: ['methods'] })
    assert.equal((details(found).papers as SavedPaper[]).length, 1)
    const audited = await f.call('lib_audit')
    assert.equal((details(audited).report as { issueCount: number }).issueCount, 0)
    const path = join(f.server.projectRoot, '.phi/library/papers', paper.storageKey)
    assert.deepEqual(JSON.parse(readFileSync(join(path, 'meta.json'), 'utf8')), current)
    assert.equal(readFileSync(join(path, 'note.md'), 'utf8'), libraryNoteMarkdown(current))
    const reopened = await new RemoteLibraryStorage(f.target).read()
    assert.deepEqual(reopened.papers, [current])
    assert.deepEqual(listPapers(f.server.localAnchor), [])
    assert.equal(existsSync(join(f.server.localAnchor, '.phi/library')), false)
    const removed = await f.call('lib_remove', { id: '10.2000/alias' })
    assert.equal(removed.isError, undefined, JSON.stringify(removed))
    assert.equal(details(removed).removed, true)
    assert.equal(existsSync(path), false)
    assert.deepEqual((await new RemoteLibraryStorage(f.target).read()).papers, [])
  }
)

test(
  'missing update/remove and invalid save preserve the missing-library no-data contract',
  { timeout: 30000 },
  async (t) => {
    const f = rpcRemoteLibraryFixture()
    t.after(() => f.close())
    assert.equal((await f.call('lib_update', { id: 'unknown', notes: 'no paper' })).isError, true)
    const removed = await f.call('lib_remove', { id: 'unknown' })
    assert.equal(removed.isError, undefined)
    assert.equal(details(removed).removed, false)
    assert.equal((await f.call('lib_save', { title: '' })).isError, true)
    assert.equal(existsSync(join(f.server.projectRoot, '.phi')), false)
  }
)

test(
  'remote audit preserves duplicate, missing-field and orphan-xref diagnostics from the shared index transform',
  { timeout: 30000 },
  async (t) => {
    const f = rpcRemoteLibraryFixture()
    t.after(() => f.close())
    const first = await f.call('lib_save', { title: 'Audited paper' })
    const paper = details(first).paper as SavedPaper
    const indexPath = join(f.server.projectRoot, '.phi/library/index.json')
    const index = JSON.parse(readFileSync(indexPath, 'utf8')) as { papers: SavedPaper[] }
    index.papers.push({
      ...paper,
      title: '',
      source: '',
      xrefs: [{ targetId: 'missing', relation: 'extends' }]
    })
    await f.server.workspace.projectHost.fs.writeAtomic(
      indexPath,
      Buffer.from(JSON.stringify(index))
    )
    const result = await f.call('lib_audit')
    assert.equal(result.isError, undefined, JSON.stringify(result))
    const report = details(result).report as { issues: Array<{ code: string }> }
    assert.deepEqual(
      report.issues.map((issue) => issue.code),
      ['duplicate_canonical_id', 'missing_title', 'missing_source', 'orphan_xref']
    )
  }
)
