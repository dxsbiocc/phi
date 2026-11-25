import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { readScientificHandoff, scientificReport } from '../src/main/agent/agents/research-handoff'
import { verifyWorkspacePlanStepChecks } from '../src/main/agent/plan/execution/workspace-step-verifier'
import type { PlanSpec, PlanStep } from '../src/shared/planRunTypes'

test('scientificReport round-trips keyMetrics and confoundersChecked and rejects invalid metric paths', () => {
  const question = 'Does treatment induce IFN-stimulated genes after controlling batch?'
  const valid = scientificReport(question, 'completed', {
    research: {
      subquestion: 'Donor-paired DESeq2 test with batch covariate',
      answer: 'Detected 18 upregulated genes at padj < 0.05 and |log2FC| >= 1.',
      interpretation: 'Supports H1 with zero pseudoreplication.',
      rationale: 'Proceed to GSEA pathway validation.',
      evidence: ['results/de.deseq2.results.tsv', 'results/de.deseq2.qc.tsv'],
      hypothesisVerdicts: [{ hypothesisId: 'h1', verdict: 'supported' }],
      keyMetrics: [
        { name: 'deg_hits', value: 18, sourcePath: 'results/de.deseq2.qc.tsv', column: 'hits' }
      ],
      confoundersChecked: ['batch', 'donor']
    },
    missingInputs: []
  })
  assert.equal(valid.structured, true)
  const replayed = readScientificHandoff(valid.text, question, 'completed')
  assert.equal(replayed.structured, true)
  const parsed = JSON.parse(replayed.text) as Record<string, unknown>
  assert.deepEqual(parsed.confoundersChecked, ['batch', 'donor'])
  assert.deepEqual(parsed.keyMetrics, [
    { name: 'deg_hits', value: 18, sourcePath: 'results/de.deseq2.qc.tsv', column: 'hits' }
  ])

  const traversal = scientificReport(question, 'completed', {
    research: {
      subquestion: 'Test traversal',
      answer: 'Attempted escape.',
      interpretation: 'None.',
      rationale: 'Stop.',
      evidence: ['results/de.tsv'],
      keyMetrics: [{ name: 'bad', value: 1, sourcePath: '../secret.tsv', column: 'hits' }]
    }
  })
  assert.equal(traversal.structured, false)
})

test('verifyWorkspacePlanStepChecks cross-checks keyMetrics against QC TSV/JSON files and rejects hallucinated numbers or unknown hypothesis IDs', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'phi-verdict-xcheck-')))
  try {
    mkdirSync(join(root, 'results'), { recursive: true })
    writeFileSync(
      join(root, 'results', 'run1.deseq2.qc.tsv'),
      'schemaVersion\tdisposition\tcontrast\tgeneIdColumn\tpadjThreshold\tlog2fcThreshold\tevaluated\thits\tresultMd5\n' +
        '1\tskip\ttreated_vs_ctrl\tgene_id\t0.05\t1\t14200\t0\td41d8cd98f00b204e9800998ecf8427e\n'
    )
    writeFileSync(
      join(root, 'results', 'gsea-summary.json'),
      JSON.stringify({ tool: 'rna_gsea', n_significant: 3 })
    )

    const step: PlanStep = {
      id: 'step-de',
      title: 'Run DESeq2',
      instructions: 'Run DESeq2 and report hits',
      acceptance: 'Accurate hit count',
      dependsOn: [],
      access: 'write',
      hypothesisIds: ['h1']
    }
    const spec: PlanSpec = {
      version: 1,
      goal: 'Test DE',
      hypotheses: [{ id: 'h1', statement: 'Treatment alters gene expression', selected: true }],
      steps: [step]
    }

    // 1. Honest zero-hit report passes cross-check
    const honestReport = scientificReport('Test DE', 'completed', {
      research: {
        subquestion: 'DESeq2 contrast',
        answer: '0 genes passed padj < 0.05.',
        interpretation: 'Valid null result; skip ORA and use pre-ranked GSEA.',
        rationale: 'Branch complete.',
        evidence: ['results/run1.deseq2.qc.tsv', 'results/gsea-summary.json'],
        hypothesisVerdicts: [{ hypothesisId: 'h1', verdict: 'refuted' }],
        keyMetrics: [
          { name: 'de_hits', value: 0, sourcePath: 'results/run1.deseq2.qc.tsv', column: 'hits' },
          {
            name: 'gsea_sig',
            value: 3,
            sourcePath: 'results/gsea-summary.json',
            column: 'n_significant'
          }
        ]
      }
    })
    const passVerdict = await verifyWorkspacePlanStepChecks(
      step,
      { kind: 'local', rootDir: root },
      { spec, reportText: honestReport.text }
    )
    assert.deepEqual(passVerdict, { ok: true, failures: [] })

    // 2. Hallucinated count (claiming 50 hits when QC file has 0) is caught and rejected!
    const hallucinatedReport = scientificReport('Test DE', 'completed', {
      research: {
        subquestion: 'DESeq2 contrast',
        answer: 'Detected 50 significant DEGs!',
        interpretation: 'Strong activation.',
        rationale: 'Done.',
        evidence: ['results/run1.deseq2.qc.tsv'],
        hypothesisVerdicts: [{ hypothesisId: 'h99', verdict: 'supported' }],
        keyMetrics: [
          { name: 'de_hits', value: 50, sourcePath: 'results/run1.deseq2.qc.tsv', column: 'hits' }
        ]
      }
    })
    const failVerdict = await verifyWorkspacePlanStepChecks(
      step,
      { kind: 'local', rootDir: root },
      { spec, reportText: hallucinatedReport.text }
    )
    assert.equal(failVerdict.ok, false)
    assert.equal(failVerdict.failures.length, 2)
    assert.ok(failVerdict.failures.some((f) => f.includes('undeclared hypothesisId "h99"')))
    assert.ok(failVerdict.failures.some((f) => f.includes('claimed 50, observed 0')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
