import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { scientificReport } from '../src/main/agent/agents/research-handoff'
import { createPlanRunState, reducePlanRun } from '../src/main/agent/plan/model/plan-run-state'
import { compilePlanProvenanceReport } from '../src/main/agent/plan/provenance-report'
import { writeScientificContextSidecar } from '../src/main/agent/scientific-context/sidecar'
import {
  writeWrapperManifestSnapshot,
  writeWrapperRun,
  writeWrapperRuntimeProvenance
} from '../src/main/agent/wrappers/store'
import { declaredValue, observedValue } from '../src/shared/scientificContextTypes'
import type { PlanSpec } from '../src/shared/planRunTypes'

test('compilePlanProvenanceReport anchors keyMetrics to SHA-256, extracts wrapper & notebook snapshots, and flags untested competing hypotheses', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'phi-prov-report-')))
  try {
    const projectRoot = join(base, 'project')
    const agentDir = join(base, 'agent-dir')
    mkdirSync(join(projectRoot, 'results'), { recursive: true })
    mkdirSync(join(projectRoot, 'notebooks'), { recursive: true })

    // 1. Write DE results TSV + .phi-context.json sidecar with donor mapping
    const dePath = join(projectRoot, 'results', 'de.tsv')
    writeFileSync(dePath, 'gene_id\tlog2FoldChange\tpadj\nISG15\t2.4\t0.0001\n')
    const sidecar = writeScientificContextSidecar(dePath, {
      producer: {
        kind: 'wrapper',
        id: 'local/modules/differential-expression-deseq2',
        runId: 'wrun_11111111-2222-3333-4444-555555555555'
      },
      location: 'local',
      path: dePath,
      hashLocalBytes: true,
      reference: declaredValue({ assembly: 'GRCh38' }, 'wrapper_param:deseq2'),
      matrix: declaredValue({ valueSemantics: 'de_stats' }, 'wrapper_manifest:deseq2'),
      samples: observedValue(
        {
          sampleIds: ['D1_ctrl', 'D1_trt', 'D2_ctrl', 'D2_trt'],
          donorBySample: { D1_ctrl: 'D1', D1_trt: 'D1', D2_ctrl: 'D2', D2_trt: 'D2' }
        },
        'samplesheet:samplesheet'
      )
    })

    // 2. Write executed Notebook with managed executionEnvironment + lockSha256
    const nbPath = join(projectRoot, 'notebooks', 'sensitivity.ipynb')
    writeFileSync(
      nbPath,
      JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {
          phi: {
            executionEnvironment: {
              kernelName: 'python3',
              source: 'managed',
              envId: 'phi-python-locked',
              lockSha256: 'abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234'
            }
          }
        },
        cells: []
      })
    )

    // 3. Persist Wrapper run snapshot + runtime provenance
    const wrapperRunId = 'wrun_11111111-2222-3333-4444-555555555555'
    writeWrapperRun(
      {
        runId: wrapperRunId,
        planId: 'wplan_1',
        revision: 1,
        state: 'completed',
        actor: 'agent',
        wrapper: {
          canonicalId: 'local/modules/differential-expression-deseq2',
          namespace: 'local',
          shortId: 'differential-expression-deseq2',
          version: '1.2.0'
        },
        trustTier: 'official_verified',
        executor: 'local',
        profile: 'docker',
        cwd: projectRoot,
        outDir: join(projectRoot, 'results'),
        createdAt: '2026-11-24T00:00:00Z',
        updatedAt: '2026-11-24T00:05:00Z'
      },
      agentDir
    )
    writeWrapperManifestSnapshot(
      wrapperRunId,
      { id: 'local/modules/differential-expression-deseq2', name: 'DESeq2' },
      agentDir
    )
    writeWrapperRuntimeProvenance(
      wrapperRunId,
      {
        capturedAt: '2026-11-24T00:01:00Z',
        host: { platform: 'darwin', arch: 'arm64', release: '24.1.0' },
        nextflow: { source: 'managed', version: '24.10.2' },
        containerRuntime: {
          engine: 'docker',
          images: [
            {
              ref: 'quay.io/biocontainers/bioconductor-deseq2:1.42.0',
              digest: 'sha256:9999888877776666555544443333222211110000aaaabbbbccccddddeeeeffff',
              status: 'verified'
            }
          ]
        }
      },
      agentDir
    )

    // 4. Build completed PlanRunState where H1 was tested & supported, while competing H2 was selected but left untested!
    const spec: PlanSpec = {
      version: 1,
      goal: 'Evaluate IFN transcriptional response in donor-paired cohort',
      literatureReview: {
        needed: true,
        rationale: 'Establish prior ISG signature',
        references: ['DOI:10.1038/s41592-024-02100-0'],
        verificationStatus: 'verified'
      },
      hypotheses: [
        {
          id: 'h1',
          statement: 'Treatment induces donor-paired ISG upregulation',
          selected: true,
          statisticalUnit: 'donor',
          falsificationCriteria: 'No ISG reaches padj < 0.05 in donor-paired model'
        },
        {
          id: 'h2',
          statement: 'Observed shift is explained purely by monocyte proportion shift',
          selected: true,
          statisticalUnit: 'donor'
        }
      ],
      steps: [
        {
          id: 's1',
          title: 'Run donor-paired DESeq2 and notebook check',
          instructions: 'Run DESeq2 and sensitivity notebook',
          acceptance: 'Verified DE output',
          dependsOn: [],
          access: 'write',
          writes: ['results/de.tsv', 'notebooks/sensitivity.ipynb'],
          hypothesisIds: ['h1']
        }
      ]
    }

    let state = createPlanRunState({
      id: 'prun_1',
      sessionId: 'sess_1',
      spec,
      now: '2026-11-24T00:00:00Z'
    })
    state = reducePlanRun(state, {
      type: 'step_launched',
      stepId: 's1',
      agentRunId: 'arun_1',
      at: '2026-11-24T00:00:01Z'
    })
    const stepHandoff = scientificReport(spec.goal, 'completed', {
      research: {
        subquestion: 'Donor-paired DESeq2 contrast',
        answer: 'ISG15 significantly upregulated after controlling donor.',
        interpretation: 'Supports H1.',
        rationale: 'Complete.',
        evidence: ['results/de.tsv', wrapperRunId],
        hypothesisVerdicts: [{ hypothesisId: 'h1', verdict: 'supported' }],
        keyMetrics: [
          {
            name: 'ISG15_log2FC',
            value: 2.4,
            sourcePath: 'results/de.tsv',
            column: 'log2FoldChange'
          }
        ],
        confoundersChecked: ['donor']
      }
    })
    state = reducePlanRun(state, {
      type: 'step_succeeded',
      stepId: 's1',
      report: { status: 'completed', text: stepHandoff.text, missingInputs: [] },
      at: '2026-11-24T00:05:00Z'
    })

    const report = compilePlanProvenanceReport({
      state,
      projectRoot,
      agentDir,
      phiVersion: '0.1.7'
    })

    assert.equal(report.phiVersion, '0.1.7')
    assert.equal(report.hypotheses.find((h) => h.id === 'h1')?.verdict, 'supported')
    assert.equal(report.hypotheses.find((h) => h.id === 'h2')?.verdict, 'untested')
    assert.deepEqual(report.epistemicAudit.untestedSelectedHypothesisIds, ['h2'])
    assert.equal(report.epistemicAudit.isExploratoryPostHoc, false)

    const deArt = report.artifacts.find((a) => a.path === 'results/de.tsv')
    assert.ok(deArt)
    assert.equal(deArt.contentSha256, sidecar.artifact.contentSha256)
    assert.equal(deArt.valueSemantics, 'de_stats')
    assert.equal(deArt.sampleCount, 4)
    assert.equal(deArt.donorCount, 2)

    assert.equal(report.wrapperRuns.length, 1)
    assert.equal(report.wrapperRuns[0]?.manifestSource, 'snapshot')
    assert.equal(report.wrapperRuns[0]?.nextflowVersion, '24.10.2')

    assert.equal(report.notebooks.length, 1)
    assert.equal(report.notebooks[0]?.envId, 'phi-python-locked')
    assert.ok(report.notebooks[0]?.lockSha256.startsWith('abcd1234'))

    assert.ok(
      report.markdown.includes(`[artifact: results/de.tsv#${deArt.contentSha256.slice(0, 12)}]`)
    )
    assert.ok(report.markdown.includes('nextflow=`24.10.2`'))
    assert.ok(report.markdown.includes('Selected hypothesis(es) remain untested (h2)'))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
