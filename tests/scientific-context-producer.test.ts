import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  finalizeScriptToolOutput,
  isPureReadOnlyScriptToolSchema
} from '../src/main/agent/content/script-tools'
import { evaluateStepScientificCompatibility } from '../src/main/agent/scientific-context/compatibility'
import {
  emitLocalWrapperOutputSidecars,
  emitScriptToolOutputSidecars
} from '../src/main/agent/scientific-context/producer'
import { readScientificContextSidecar } from '../src/main/agent/scientific-context/sidecar'
import { parseWrapperCompositionManifest } from '../src/main/agent/wrappers/composition/manifest'

test('parseWrapperCompositionManifest parses optional output scientificContext declarations and rejects unknown semantics', () => {
  const manifest = parseWrapperCompositionManifest(`
id: nf-core/modules/salmon-quant
name: Salmon Quantification
summary: Quantifies transcript and gene counts.
params:
  samplesheet:
    kind: input
    type: file
    required: true
  genome:
    kind: option
    type: string
    required: false
  outdir:
    kind: output
    type: directory
    required: true
outputs:
  counts:
    type: file
    path: "{outdir}/salmon.merged.gene_counts.tsv"
    primary: true
    assertions:
      nonEmpty: true
      format: tsv
      minDataRows: 1
    scientificContext:
      valueSemantics: raw_counts
      rowIdType: gene_id
      referenceAssemblyParam: genome
      samplesheetParam: samplesheet
`)

  assert.deepEqual(manifest.outputs.counts.scientificContext, {
    valueSemantics: 'raw_counts',
    rowIdType: 'gene_id',
    referenceAssemblyParam: 'genome',
    samplesheetParam: 'samplesheet'
  })

  assert.throws(() =>
    parseWrapperCompositionManifest(`
id: nf-core/modules/bad
name: Bad
summary: Bad semantics
params:
  outdir:
    kind: output
    type: directory
    required: true
outputs:
  counts:
    type: file
    path: "{outdir}/counts.tsv"
    primary: true
    scientificContext:
      valueSemantics: bogus_semantics
`)
  )
})

test('emitLocalWrapperOutputSidecars binds real SHA-256, samplesheet donor mapping, and enables end-to-end inputContracts preflight', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'phi-ctx-producer-')))
  try {
    mkdirSync(join(root, 'results'), { recursive: true })
    const sheetPath = join(root, 'samplesheet.csv')
    const countsPath = join(root, 'results', 'counts.tsv')
    writeFileSync(
      sheetPath,
      'sample,donor,fastq_1,fastq_2\nS1_T,P01,a_1.fq.gz,a_2.fq.gz\nS1_N,P01,b_1.fq.gz,b_2.fq.gz\n'
    )
    writeFileSync(countsPath, 'gene_id\tS1_T\tS1_N\nENSG1\t120\t45\n')

    const written = emitLocalWrapperOutputSidecars({
      wrapperId: 'nf-core/modules/salmon-quant',
      runId: 'wrun_salmon_01',
      outputs: [
        {
          id: 'counts',
          path: countsPath,
          exists: true,
          primary: true,
          location: 'local'
        }
      ],
      declarationsByOutputId: {
        counts: {
          valueSemantics: 'raw_counts',
          rowIdType: 'gene_id',
          referenceAssemblyParam: 'genome',
          samplesheetParam: 'samplesheet'
        }
      },
      params: {
        genome: 'GRCh38.p14',
        samplesheet: 'samplesheet.csv'
      },
      baseDir: root
    })

    assert.equal(written.length, 1)
    const { found, sidecar } = readScientificContextSidecar(countsPath)
    assert.equal(found, true)
    assert.equal(sidecar.producer.kind, 'wrapper')
    assert.equal(sidecar.producer.runId, 'wrun_salmon_01')
    assert.ok(sidecar.artifact.contentSha256 && sidecar.artifact.contentSha256.length === 64)
    assert.equal(
      sidecar.samples.status === 'observed' ? sidecar.samples.value.donorBySample?.S1_T : undefined,
      'P01'
    )

    // Downstream paired DESeq2 step passes preflight automatically!
    const preflightPass = evaluateStepScientificCompatibility(
      {
        id: 'deseq2',
        title: 'Run paired DESeq2',
        instructions: 'Fit paired model',
        acceptance: 'de.tsv',
        dependsOn: [],
        access: 'write',
        inputContracts: [
          {
            path: 'results/counts.tsv',
            expectedReferenceAssembly: 'GRCh38.p14',
            requiredMatrixSemantics: ['raw_counts'],
            requireDonorMapping: true
          }
        ]
      },
      root
    )
    assert.deepEqual(preflightPass, { status: 'compatible' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('emitScriptToolOutputSidecars writes host-hashed sidecars inside projectDir and refuses traversal or symlink escapes', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'phi-script-ctx-')))
  try {
    const projectDir = join(base, 'proj')
    const outsideDir = join(base, 'outside')
    mkdirSync(join(projectDir, 'norm'), { recursive: true })
    mkdirSync(outsideDir, { recursive: true })

    const tpmPath = join(projectDir, 'norm', 'tpm.tsv')
    const outsideFile = join(outsideDir, 'secret.tsv')
    writeFileSync(tpmPath, 'gene_id\tS1\nG1\t42.5\n')
    writeFileSync(outsideFile, 'secret\n')
    symlinkSync(outsideFile, join(projectDir, 'norm', 'link.tsv'))

    const res = emitScriptToolOutputSidecars({
      projectDir,
      toolName: 'rnaseq_normalize_tpm',
      envId: 'env_py_123',
      rawContextMap: {
        'norm/tpm.tsv': {
          organism: 'Homo sapiens',
          referenceAssembly: 'GRCh38',
          valueSemantics: 'tpm',
          sampleIds: ['S1'],
          // Script attempts to spoof contentSha256 — host must ignore and compute real hash!
          contentSha256: '0000000000000000000000000000000000000000000000000000000000000000'
        },
        '../outside/secret.tsv': {
          valueSemantics: 'raw_counts'
        },
        'norm/link.tsv': {
          valueSemantics: 'raw_counts'
        }
      }
    })

    assert.deepEqual(res.writtenPaths, ['norm/tpm.tsv'])
    assert.equal(res.warnings.length, 2)

    const { found, sidecar } = readScientificContextSidecar(tpmPath)
    assert.equal(found, true)
    assert.notEqual(
      sidecar.artifact.contentSha256,
      '0000000000000000000000000000000000000000000000000000000000000000'
    )
    assert.equal(
      sidecar.matrix.status === 'declared' ? sidecar.matrix.value.valueSemantics : undefined,
      'tpm'
    )
    assert.equal(readScientificContextSidecar(outsideFile).found, false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('isPureReadOnlyScriptToolSchema blocks tools declaring project-path write parameters', () => {
  assert.equal(
    isPureReadOnlyScriptToolSchema({
      type: 'object',
      properties: {
        matrix: { type: 'string', format: 'input-path' },
        group_col: { type: 'string' }
      }
    }),
    true
  )
  assert.equal(
    isPureReadOnlyScriptToolSchema({
      type: 'object',
      properties: {
        input: { type: 'string', format: 'input-path' },
        output: { type: 'string', format: 'project-path' }
      }
    }),
    false
  )
})

test('finalizeScriptToolOutput accepts strict additionalProperties:false outputSchema alongside scientificContext', () => {
  const projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'phi-strict-script-')))
  try {
    const outFile = join(projectDir, 'counts.tsv')
    writeFileSync(outFile, 'gene_id\tS1\tS2\nG1\t10\t20\n')

    const res = finalizeScriptToolOutput(
      {
        tool: {
          name: 'sc_pseudobulk',
          description: 'Aggregate raw counts by donor',
          run: ['python', 'pseudobulk.py'],
          approval: 'write',
          attachTo: ['SingleCell'],
          args: {
            type: 'object',
            properties: { output: { type: 'string', format: 'project-path' } }
          },
          outputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['tool', 'n_donors'],
            properties: {
              tool: { type: 'string' },
              n_donors: { type: 'integer' }
            }
          }
        },
        args: { output: 'counts.tsv' }
      },
      projectDir,
      JSON.stringify({
        tool: 'sc_pseudobulk',
        n_donors: 2,
        scientificContext: {
          'counts.tsv': {
            organism: 'Homo sapiens',
            valueSemantics: 'raw_counts',
            sampleIds: ['S1', 'S2'],
            donorBySample: { S1: 'D1', S2: 'D2' }
          }
        }
      }),
      'env_scanpy_1'
    )

    assert.equal(res.ok, true)
    const { found, sidecar } = readScientificContextSidecar(outFile)
    assert.equal(found, true)
    assert.equal(
      sidecar.matrix.status === 'declared' ? sidecar.matrix.value.valueSemantics : undefined,
      'raw_counts'
    )
    assert.deepEqual(
      sidecar.samples.status === 'observed' ? sidecar.samples.value.donorBySample : undefined,
      { S1: 'D1', S2: 'D2' }
    )
  } finally {
    rmSync(projectDir, { recursive: true, force: true })
  }
})
