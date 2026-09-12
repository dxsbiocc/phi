import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  ensureBundledWrappersInstalled,
  listWrapperCatalog,
  type WrapperCatalogEntry
} from '../src/main/agent/wrappers/catalog'
import {
  createWrapperRunPlan,
  isWrapperPlanExpired,
  reviseWrapperRunPlan
} from '../src/main/agent/wrappers/plans'
import { readWrapperPlanArtifact } from '../src/main/agent/wrappers/store'
import type { WrapperRunPlan } from '../src/main/agent/wrappers/types'

function withHarness<T>(callback: (harness: { agentDir: string; projectDir: string }) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'phi-wrapper-plans-'))
  const agentDir = join(root, '.phi-home')
  const projectDir = join(root, 'project')
  mkdirSync(projectDir, { recursive: true })
  try {
    return callback({ agentDir, projectDir })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function writeFastqPair(projectDir: string, sample: string): void {
  mkdirSync(join(projectDir, 'data'), { recursive: true })
  writeFileSync(join(projectDir, 'data', `${sample}_R1.fastq.gz`), 'r1')
  writeFileSync(join(projectDir, 'data', `${sample}_R2.fastq.gz`), 'r2')
}

function fastqQcWrapper(agentDir: string): WrapperCatalogEntry {
  ensureBundledWrappersInstalled(agentDir)
  const entry = listWrapperCatalog(agentDir).find((item) => item.manifest.id === 'phi/ngs/fastq-qc')
  if (!entry) throw new Error('fastq-qc fixture not installed')
  return entry
}

test('createWrapperRunPlan always resolves executor "local" and a valid plan for good params', () => {
  withHarness(({ agentDir, projectDir }) => {
    writeFastqPair(projectDir, 'S1')
    const wrapper = fastqQcWrapper(agentDir)

    const plan = createWrapperRunPlan({
      actor: 'agent',
      wrapper,
      params: { reads: 'data/*_{R1,R2}.fastq.gz', threads: 8 },
      cwd: projectDir,
      agentDir
    })

    assert.equal(plan.executor, 'local')
    assert.equal(plan.state, 'valid')
    assert.equal(plan.validation.valid, true)
    assert.deepEqual(plan.validation.errors, [])
    assert.equal(plan.profile, 'local')
    assert.match(plan.commandPlan.command, /^nextflow run main\.nf .*-profile local$/)
  })
})

test('createWrapperRunPlan fails validation when the input glob matches nothing', () => {
  withHarness(({ agentDir, projectDir }) => {
    const wrapper = fastqQcWrapper(agentDir)

    const plan = createWrapperRunPlan({
      actor: 'agent',
      wrapper,
      params: { reads: 'data/*_{R1,R2}.fastq.gz' },
      cwd: projectDir,
      agentDir
    })

    assert.equal(plan.state, 'invalid')
    assert.equal(plan.validation.valid, false)
    assert.ok(plan.validation.errors.some((error) => error.includes('没有匹配到任何文件')))
  })
})

test('createWrapperRunPlan persists a generated samplesheet for paired-end fastq input', () => {
  withHarness(({ agentDir, projectDir }) => {
    writeFastqPair(projectDir, 'S1')
    writeFastqPair(projectDir, 'S2')
    const wrapper = fastqQcWrapper(agentDir)

    const plan = createWrapperRunPlan({
      actor: 'user',
      wrapper,
      params: { reads: 'data/*_{R1,R2}.fastq.gz' },
      cwd: projectDir,
      agentDir
    })

    assert.equal(plan.state, 'valid')
    const csv = readWrapperPlanArtifact(plan.planId, 'reads.samplesheet.csv', agentDir)
    assert.ok(csv)
    const lines = csv!.trim().split('\n')
    assert.equal(lines[0], 'sample,fastq_1,fastq_2')
    assert.equal(lines.length, 3)
  })
})

test('createWrapperRunPlan flags a heavy/hpc resourceClass wrapper as requiring acknowledgement', () => {
  withHarness(({ agentDir, projectDir }) => {
    const wrapper = fastqQcWrapper(agentDir)
    const heavyWrapper = {
      ...wrapper,
      manifest: { ...wrapper.manifest, resourceClass: 'heavy' as const }
    }
    writeFastqPair(projectDir, 'S1')

    const plan = createWrapperRunPlan({
      actor: 'agent',
      wrapper: heavyWrapper,
      params: { reads: 'data/*_{R1,R2}.fastq.gz' },
      cwd: projectDir,
      agentDir
    })

    assert.equal(plan.requiresHeavyWorkloadAcknowledgement, true)
    assert.equal(plan.heavyWorkloadAcknowledged, false)
    // Still valid and locally runnable — Phase 1 warns rather than blocks (no remote to redirect to).
    assert.equal(plan.state, 'valid')
  })
})

test('reviseWrapperRunPlan keeps the same planId and bumps the revision', () => {
  withHarness(({ agentDir, projectDir }) => {
    writeFastqPair(projectDir, 'S1')
    const wrapper = fastqQcWrapper(agentDir)

    const initial = createWrapperRunPlan({
      actor: 'agent',
      wrapper,
      params: { reads: 'data/*_{R1,R2}.fastq.gz', threads: 4 },
      cwd: projectDir,
      agentDir
    })
    assert.equal(initial.revision, 1)

    const revised = reviseWrapperRunPlan(
      initial.planId,
      { reads: 'data/*_{R1,R2}.fastq.gz', threads: 16 },
      { actor: 'agent', wrapper, cwd: projectDir, agentDir }
    )

    assert.equal(revised.planId, initial.planId)
    assert.equal(revised.revision, 2)
    assert.equal((revised.params as { threads: number }).threads, 16)
  })
})

test('isWrapperPlanExpired reflects the plan TTL', () => {
  const base: Pick<WrapperRunPlan, 'expiresAt'> = {
    expiresAt: new Date(Date.now() - 1000).toISOString()
  }
  assert.equal(isWrapperPlanExpired(base as WrapperRunPlan), true)

  const future: Pick<WrapperRunPlan, 'expiresAt'> = {
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  }
  assert.equal(isWrapperPlanExpired(future as WrapperRunPlan), false)
})
