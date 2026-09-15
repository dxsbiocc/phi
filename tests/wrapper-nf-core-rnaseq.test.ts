import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createWrapperRunPlan } from '../src/main/agent/wrappers/plans'
import type { WrapperCatalogEntry } from '../src/main/agent/wrappers/catalog'
import { installLegacyRnaseqWrapper } from './helpers/wrapperFixtures'

/**
 * Plan-creation coverage for the legacy package-level nf-core/rnaseq
 * manifest shape. The bundled package itself moved out of
 * `resources/wrappers/`; these tests still exercise `plans.ts` against the
 * old manifest contract using a test-only install.
 */

function withHarness<T>(callback: (harness: { agentDir: string; projectDir: string }) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'phi-wrapper-nf-core-rnaseq-'))
  const agentDir = join(root, '.phi-home')
  const projectDir = join(root, 'project')
  mkdirSync(projectDir, { recursive: true })
  try {
    return callback({ agentDir, projectDir })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function rnaseqWrapper(agentDir: string, projectDir: string): WrapperCatalogEntry {
  return installLegacyRnaseqWrapper(agentDir, projectDir)
}

/** A hand-authored nf-core-style samplesheet — see wrapper.yaml's `input` doc comment for why this isn't auto-generated from a glob. */
function writeProjectInputs(projectDir: string): void {
  mkdirSync(join(projectDir, 'ref'), { recursive: true })
  writeFileSync(
    join(projectDir, 'samplesheet.csv'),
    'sample,fastq_1,fastq_2,strandedness\n' +
      'sample1,https://example.com/s1_R1.fastq.gz,https://example.com/s1_R2.fastq.gz,auto\n'
  )
  writeFileSync(join(projectDir, 'ref', 'genome.fa'), '>chr1\nACGT\n')
  writeFileSync(join(projectDir, 'ref', 'genes.gtf'), '# minimal placeholder GTF\n')
}

test('createWrapperRunPlan resolves the nf-core/rnaseq manifest to a valid local plan', () => {
  withHarness(({ agentDir, projectDir }) => {
    const wrapper = rnaseqWrapper(agentDir, projectDir)
    writeProjectInputs(projectDir)

    const plan = createWrapperRunPlan({
      actor: 'agent',
      wrapper,
      params: {
        input: 'samplesheet.csv',
        fasta: 'ref/genome.fa',
        gtf: 'ref/genes.gtf'
      },
      cwd: projectDir,
      agentDir
    })

    assert.equal(plan.state, 'valid', plan.validation.errors.join('; '))
    assert.equal(plan.executor, 'local')
    assert.equal(plan.resourceClass, 'hpc')
    // hpc resourceClass + local executor: Phase 1 has no remote to redirect
    // to, so it warns via the acknowledgement gate rather than blocking —
    // see policy.ts's requiresHeavyWorkloadAcknowledgement doc comment.
    assert.equal(plan.requiresHeavyWorkloadAcknowledgement, true)
  })
})

test('createWrapperRunPlan substitutes resolved absolute paths for input/fasta/gtf into params.json', () => {
  withHarness(({ agentDir, projectDir }) => {
    const wrapper = rnaseqWrapper(agentDir, projectDir)
    writeProjectInputs(projectDir)

    const plan = createWrapperRunPlan({
      actor: 'agent',
      wrapper,
      params: {
        input: 'samplesheet.csv',
        fasta: 'ref/genome.fa',
        gtf: 'ref/genes.gtf'
      },
      cwd: projectDir,
      agentDir
    })

    assert.equal(plan.params.input, join(projectDir, 'samplesheet.csv'))
    assert.equal(plan.params.fasta, join(projectDir, 'ref', 'genome.fa'))
    assert.equal(plan.params.gtf, join(projectDir, 'ref', 'genes.gtf'))
  })
})

test("createWrapperRunPlan uses the local profile's declared nextflowProfile (docker) for -profile, not the Phi id", () => {
  withHarness(({ agentDir, projectDir }) => {
    const wrapper = rnaseqWrapper(agentDir, projectDir)
    writeProjectInputs(projectDir)

    const plan = createWrapperRunPlan({
      actor: 'agent',
      wrapper,
      params: {
        input: 'samplesheet.csv',
        fasta: 'ref/genome.fa',
        gtf: 'ref/genes.gtf'
      },
      cwd: projectDir,
      agentDir
    })

    assert.equal(plan.profile, 'local')
    assert.equal(plan.nextflowProfile, 'docker')
    assert.match(plan.commandPlan.command, /-profile docker$/)
    assert.match(plan.commandPlan.command, /main\.nf/)
  })
})

test('createWrapperRunPlan fails validation when a required reference input is missing', () => {
  withHarness(({ agentDir, projectDir }) => {
    const wrapper = rnaseqWrapper(agentDir, projectDir)
    writeProjectInputs(projectDir)

    const plan = createWrapperRunPlan({
      actor: 'agent',
      wrapper,
      params: { input: 'samplesheet.csv', fasta: 'ref/genome.fa' },
      cwd: projectDir,
      agentDir
    })

    assert.equal(plan.state, 'invalid')
    assert.ok(plan.validation.errors.some((error) => error.includes('gtf')))
  })
})

test('createWrapperRunPlan rejects an aligner value outside the declared enum', () => {
  withHarness(({ agentDir, projectDir }) => {
    const wrapper = rnaseqWrapper(agentDir, projectDir)
    writeProjectInputs(projectDir)

    const plan = createWrapperRunPlan({
      actor: 'agent',
      wrapper,
      params: {
        input: 'samplesheet.csv',
        fasta: 'ref/genome.fa',
        gtf: 'ref/genes.gtf',
        aligner: 'not-a-real-aligner'
      },
      cwd: projectDir,
      agentDir
    })

    assert.equal(plan.state, 'invalid')
  })
})
