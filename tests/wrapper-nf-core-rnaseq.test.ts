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
 * Plan-creation coverage for the vendored nf-core/rnaseq wrapper — the
 * first bundled wrapper around a real, unmodified upstream pipeline (every
 * other bundled wrapper is a Phi-authored demo script with no real source
 * behind it). These tests exercise `plans.ts` against the wrapper's real
 * `wrapper.yaml`, not a synthetic fixture — catches manifest-authoring
 * mistakes (a typo'd input id, a schema/param mismatch) that a synthetic
 * test manifest would never surface. Actual pipeline *execution* (spawning
 * real Nextflow/Docker against this wrapper) is out of scope here — see
 * `runs.ts`/`executor-local.ts`'s own tests for execution-layer coverage
 * against fakes, and the wrapper.yaml's own doc comment for what real
 * verification (real Nextflow parsing, real Docker containers) was done
 * manually while authoring it.
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

function rnaseqWrapper(agentDir: string): WrapperCatalogEntry {
  ensureBundledWrappersInstalled(agentDir)
  const entry = listWrapperCatalog(agentDir).find(
    (item) => item.manifest.id === 'nf-core/rnaseq/rnaseq'
  )
  if (!entry) throw new Error('nf-core/rnaseq fixture not installed')
  return entry
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
    const wrapper = rnaseqWrapper(agentDir)
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
    const wrapper = rnaseqWrapper(agentDir)
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
    const wrapper = rnaseqWrapper(agentDir)
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
    const wrapper = rnaseqWrapper(agentDir)
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
    const wrapper = rnaseqWrapper(agentDir)
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
