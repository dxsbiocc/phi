import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  auditLibrary,
  findPapers,
  getProjectLibraryDir,
  listPapers,
  removePaper,
  savePaper,
  updatePaper
} from '../src/main/agent/library/library-store'

function withProject<T>(callback: (projectDir: string) => T): T {
  const projectDir = mkdtempSync(join(tmpdir(), 'phi-library-store-'))
  try {
    return callback(projectDir)
  } finally {
    rmSync(projectDir, { recursive: true, force: true })
  }
}

test('listing a missing library returns empty without creating project .phi data', () => {
  withProject((projectDir) => {
    assert.deepEqual(listPapers(projectDir), [])
    assert.equal(existsSync(getProjectLibraryDir(projectDir)), false)
  })
})

test('savePaper creates the project library index and paper projections', () => {
  withProject((projectDir) => {
    const result = savePaper(projectDir, {
      source: 'pubmed',
      sourceId: '12345',
      title: 'A Useful Assay',
      authors: ['Ada Lovelace', 'Grace Hopper'],
      doi: 'https://doi.org/10.1000/Example',
      tags: ['methods'],
      notes: 'Read for protocol details.',
      priorityTier: 'must'
    })

    assert.equal(result.action, 'created')
    assert.equal(result.paper.canonicalId, 'doi:10.1000/example')
    assert.equal(result.paper.revision, 1)

    const libraryDir = getProjectLibraryDir(projectDir)
    const index = JSON.parse(readFileSync(join(libraryDir, 'index.json'), 'utf-8')) as {
      papers: Array<{ title: string; storageKey: string }>
    }
    assert.equal(index.papers[0]?.title, 'A Useful Assay')
    assert.ok(index.papers[0]?.storageKey)

    const paperDir = join(libraryDir, 'papers', result.paper.storageKey)
    assert.equal(existsSync(join(paperDir, 'meta.json')), true)
    assert.match(readFileSync(join(paperDir, 'note.md'), 'utf-8'), /# A Useful Assay/)
  })
})

test('savePaper exact-deduplicates by normalized title while preserving the existing record', () => {
  withProject((projectDir) => {
    const first = savePaper(projectDir, {
      source: 'arxiv',
      sourceId: '2609.00001',
      title: 'Alpha—Beta  Response',
      tags: ['screen'],
      notes: 'Keep this note.'
    })
    const second = savePaper(projectDir, {
      source: 'europepmc',
      sourceId: 'PMC1',
      title: 'Alpha-Beta Response',
      authors: ['New Author'],
      doi: '10.2000/abc'
    })

    assert.equal(second.action, 'updated')
    assert.equal(listPapers(projectDir).length, 1)
    assert.equal(second.paper.canonicalId, first.paper.canonicalId)
    assert.ok(second.paper.aliases.includes('doi:10.2000/abc'))
    assert.equal(second.paper.notes, 'Keep this note.')
    assert.deepEqual(second.paper.authors, ['New Author'])
  })
})

test('findPapers searches local metadata and update/remove resolve DOI or source ids', () => {
  withProject((projectDir) => {
    const saved = savePaper(projectDir, {
      source: 'pubmed',
      sourceId: '777',
      title: 'Single Cell Atlas',
      authors: ['Reviewer'],
      doi: '10.3000/atlas',
      collectionId: 'atlas',
      tags: ['scrna']
    })

    assert.deepEqual(
      findPapers(projectDir, 'cell', { tags: ['scrna'] }).map((paper) => paper.canonicalId),
      [saved.paper.canonicalId]
    )

    const updated = updatePaper(projectDir, '10.3000/atlas', {
      processingStage: 'skimmed',
      notes: 'Skimmed for dataset scope.'
    })
    assert.equal(updated.processingStage, 'skimmed')
    assert.equal(updated.revision, 2)

    const removed = removePaper(projectDir, '777')
    assert.equal(removed.removed, true)
    assert.deepEqual(listPapers(projectDir), [])
  })
})

test('auditLibrary reports orphan xrefs', () => {
  withProject((projectDir) => {
    const saved = savePaper(projectDir, {
      title: 'Network Biology',
      xrefs: [{ targetId: 'missing-paper', relation: 'extends' }]
    })

    const report = auditLibrary(projectDir)
    assert.equal(report.paperCount, 1)
    assert.deepEqual(
      report.issues.map((issue) => ({
        code: issue.code,
        paperId: issue.paperId
      })),
      [{ code: 'orphan_xref', paperId: saved.paper.canonicalId }]
    )
  })
})
