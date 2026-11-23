import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { declaredValue, observedValue } from '../src/shared/scientificContextTypes'
import {
  computeArtifactSha256,
  readScientificContextSidecar,
  writeScientificContextSidecar
} from '../src/main/agent/scientific-context/sidecar'

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'phi-sci-ctx-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('sidecar persists observed/declared/unknown provenance and real file SHA-256', () => {
  withTempDir((dir) => {
    const countsPath = join(dir, 'counts.tsv')
    writeFileSync(countsPath, 'gene_id\tS1\tS2\nENSG1\t10\t20\n', 'utf-8')
    const expectedHash = computeArtifactSha256(countsPath)
    assert.match(expectedHash ?? '', /^[0-9a-f]{64}$/)

    const written = writeScientificContextSidecar(countsPath, {
      producer: { kind: 'wrapper', id: 'nf-core/modules/salmon', runId: 'wrun_1' },
      location: 'local',
      path: countsPath,
      hashLocalBytes: true,
      organism: declaredValue('Homo sapiens', 'task_metadata'),
      reference: observedValue(
        { assembly: 'GRCh38.p14', annotation: 'GENCODE v44' },
        'wrapper:salmon:index'
      ),
      samples: observedValue(
        { sampleIds: ['S1', 'S2'], donorBySample: { S1: 'D1', S2: 'D1' } },
        'samplesheet'
      ),
      matrix: observedValue(
        { rowIdType: 'ensembl_gene_id', columnIds: ['S1', 'S2'], valueSemantics: 'raw_counts' },
        'wrapper:salmon:tximport'
      )
    })

    const loaded = readScientificContextSidecar(countsPath)
    assert.equal(loaded.found, true)
    assert.deepEqual(loaded.sidecar, written)
    assert.equal(loaded.sidecar.artifact.contentSha256, expectedHash)
    assert.equal(loaded.sidecar.matrix.status, 'observed')
  })
})

test('legacy artifact without sidecar reads as explicit unknown rather than guessing defaults', () => {
  withTempDir((dir) => {
    const legacyPath = join(dir, 'legacy.tsv')
    writeFileSync(legacyPath, 'gene_id\tS1\nG1\t5\n')

    const loaded = readScientificContextSidecar(legacyPath)
    assert.equal(loaded.found, false)
    assert.equal(loaded.sidecar.organism.status, 'unknown')
    assert.equal(loaded.sidecar.reference.status, 'unknown')
    assert.equal(loaded.sidecar.samples.status, 'unknown')
    assert.equal(loaded.sidecar.matrix.status, 'unknown')
    assert.equal(loaded.sidecar.artifact.contentSha256, undefined)
  })
})

test('remote artifact identity preserves host so local and remote identical paths never collide', () => {
  withTempDir((dir) => {
    const localMirror = join(dir, 'remote_counts.tsv')
    const written = writeScientificContextSidecar(localMirror, {
      producer: { kind: 'wrapper', id: 'nf-core/modules/salmon' },
      location: 'remote',
      host: 'hpc-login-01',
      path: '/scratch/results/counts.tsv'
    })
    assert.equal(written.artifact.location, 'remote')
    assert.equal(written.artifact.host, 'hpc-login-01')
    assert.equal(written.artifact.contentSha256, undefined)
  })
})
