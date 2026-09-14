import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  ensureBundledWrappersInstalled,
  listWrapperCatalog
} from '../src/main/agent/wrappers/catalog'
import { createWrapperRunPlan } from '../src/main/agent/wrappers/plans'
import type { WrapperCatalogEntry } from '../src/main/agent/wrappers/catalog'

/**
 * Plan-creation coverage for the standalone wrappers around individual
 * nf-core/rnaseq modules (fastqc/trimgalore/star-align/salmon-quant/
 * multiqc — see fixtures/nf-core-rnaseq-fastqc/wrapper.yaml's doc comment
 * for why these exist alongside, not composed into, the full pipeline
 * wrapper). Exercises `plans.ts` against each wrapper's real `wrapper.yaml`
 * — catches manifest-authoring mistakes a synthetic test manifest would
 * never surface. Actual pipeline *execution* (real Nextflow/Docker) is out
 * of scope for an automated test here — all five were verified manually
 * end to end while authoring them; see each wrapper.yaml's doc comment.
 */

function withHarness<T>(callback: (harness: { agentDir: string; projectDir: string }) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'phi-wrapper-nf-core-modules-'))
  const agentDir = join(root, '.phi-home')
  const projectDir = join(root, 'project')
  mkdirSync(projectDir, { recursive: true })
  try {
    return callback({ agentDir, projectDir })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function moduleWrapper(agentDir: string, canonicalId: string): WrapperCatalogEntry {
  ensureBundledWrappersInstalled(agentDir)
  const entry = listWrapperCatalog(agentDir).find((item) => item.manifest.id === canonicalId)
  if (!entry) throw new Error(`${canonicalId} fixture not installed`)
  return entry
}

function writeFastqPair(projectDir: string, sample: string): void {
  mkdirSync(join(projectDir, 'data'), { recursive: true })
  writeFileSync(join(projectDir, 'data', `${sample}_R1.fastq.gz`), 'r1')
  writeFileSync(join(projectDir, 'data', `${sample}_R2.fastq.gz`), 'r2')
}

function writeReferenceFiles(projectDir: string): void {
  mkdirSync(join(projectDir, 'ref'), { recursive: true })
  writeFileSync(join(projectDir, 'ref', 'genome.fa'), '>chr1\nACGT\n')
  writeFileSync(join(projectDir, 'ref', 'genes.gtf'), '# minimal placeholder GTF\n')
}

test('createWrapperRunPlan resolves a valid local plan for the standalone FastQC wrapper', () => {
  withHarness(({ agentDir, projectDir }) => {
    const wrapper = moduleWrapper(agentDir, 'nf-core/rnaseq/fastqc')
    writeFastqPair(projectDir, 'S1')

    const plan = createWrapperRunPlan({
      actor: 'agent',
      wrapper,
      params: { reads: 'data/*_{R1,R2}.fastq.gz' },
      cwd: projectDir,
      agentDir
    })

    assert.equal(plan.state, 'valid', plan.validation.errors.join('; '))
    assert.equal(plan.executor, 'local')
    assert.equal(plan.profile, 'local')
    assert.equal(plan.nextflowProfile, 'docker')
    assert.equal(plan.resourceClass, 'light')
    assert.equal(plan.requiresHeavyWorkloadAcknowledgement, undefined)
  })
})

test('createWrapperRunPlan resolves a valid local plan for the standalone Trim Galore wrapper', () => {
  withHarness(({ agentDir, projectDir }) => {
    const wrapper = moduleWrapper(agentDir, 'nf-core/rnaseq/trimgalore')
    writeFastqPair(projectDir, 'S1')

    const plan = createWrapperRunPlan({
      actor: 'agent',
      wrapper,
      params: { reads: 'data/*_{R1,R2}.fastq.gz' },
      cwd: projectDir,
      agentDir
    })

    assert.equal(plan.state, 'valid', plan.validation.errors.join('; '))
    assert.equal(plan.resourceClass, 'light')
  })
})

test('createWrapperRunPlan resolves a valid local plan for the standalone STAR align wrapper', () => {
  withHarness(({ agentDir, projectDir }) => {
    const wrapper = moduleWrapper(agentDir, 'nf-core/rnaseq/star-align')
    writeFastqPair(projectDir, 'S1')
    writeReferenceFiles(projectDir)

    const plan = createWrapperRunPlan({
      actor: 'agent',
      wrapper,
      params: {
        reads: 'data/*_{R1,R2}.fastq.gz',
        fasta: 'ref/genome.fa',
        gtf: 'ref/genes.gtf'
      },
      cwd: projectDir,
      agentDir
    })

    assert.equal(plan.state, 'valid', plan.validation.errors.join('; '))
    assert.equal(plan.resourceClass, 'hpc')
    // Heavy/hpc local runs need the acknowledgement gate — see policy.ts.
    assert.equal(plan.requiresHeavyWorkloadAcknowledgement, true)
    assert.equal(plan.params.fasta, join(projectDir, 'ref', 'genome.fa'))
    assert.equal(plan.params.gtf, join(projectDir, 'ref', 'genes.gtf'))
  })
})

test('createWrapperRunPlan resolves a valid local plan for the standalone Salmon quant wrapper', () => {
  withHarness(({ agentDir, projectDir }) => {
    const wrapper = moduleWrapper(agentDir, 'nf-core/rnaseq/salmon-quant')
    writeFastqPair(projectDir, 'S1')
    writeReferenceFiles(projectDir)

    const plan = createWrapperRunPlan({
      actor: 'agent',
      wrapper,
      params: {
        reads: 'data/*_{R1,R2}.fastq.gz',
        fasta: 'ref/genome.fa',
        gtf: 'ref/genes.gtf'
      },
      cwd: projectDir,
      agentDir
    })

    assert.equal(plan.state, 'valid', plan.validation.errors.join('; '))
    assert.equal(plan.resourceClass, 'standard')
    assert.equal(plan.requiresHeavyWorkloadAcknowledgement, undefined)
  })
})

test('createWrapperRunPlan resolves a valid local plan for the standalone MultiQC wrapper', () => {
  withHarness(({ agentDir, projectDir }) => {
    const wrapper = moduleWrapper(agentDir, 'nf-core/rnaseq/multiqc')
    mkdirSync(join(projectDir, 'reports'), { recursive: true })
    writeFileSync(join(projectDir, 'reports', 'sample1_fastqc.zip'), 'zip')

    const plan = createWrapperRunPlan({
      actor: 'agent',
      wrapper,
      params: { input: 'reports/*' },
      cwd: projectDir,
      agentDir
    })

    assert.equal(plan.state, 'valid', plan.validation.errors.join('; '))
    assert.match(plan.commandPlan.command, /-profile docker$/)
  })
})

test('createWrapperRunPlan fails validation for the STAR align wrapper when the reference genome is missing', () => {
  withHarness(({ agentDir, projectDir }) => {
    const wrapper = moduleWrapper(agentDir, 'nf-core/rnaseq/star-align')
    writeFastqPair(projectDir, 'S1')

    const plan = createWrapperRunPlan({
      actor: 'agent',
      wrapper,
      params: { reads: 'data/*_{R1,R2}.fastq.gz' },
      cwd: projectDir,
      agentDir
    })

    assert.equal(plan.state, 'invalid')
    assert.ok(plan.validation.errors.some((error) => error.includes('fasta')))
    assert.ok(plan.validation.errors.some((error) => error.includes('gtf')))
  })
})
