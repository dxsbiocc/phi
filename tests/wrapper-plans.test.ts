import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createProject,
  updateProjectRemoteConnection,
  updateProjectRemoteDefaults
} from '../src/main/agent/projects'
import { RUNTIME_AGENT_DIR_ENV } from '../src/main/agent/runtime-paths'
import type { WrapperCatalogEntry } from '../src/main/agent/wrappers/catalog'
import {
  createWrapperRunPlan,
  isWrapperPlanExpired,
  reviseWrapperRunPlan
} from '../src/main/agent/wrappers/plans'
import { readWrapperPlanArtifact } from '../src/main/agent/wrappers/store'
import type { WrapperRunPlan } from '../src/main/agent/wrappers/types'
import { installLegacyFastqQcWrapper } from './helpers/wrapperFixtures'

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

/**
 * Like `withHarness`, but also points `projects.ts` (which always resolves
 * `getPhiAgentDir()` from `RUNTIME_AGENT_DIR_ENV`, ignoring any explicit
 * `agentDir` argument — unlike every wrapper-storage function) at the same
 * temp dir, so a project created here and `resolveExecutor`'s internal
 * `getProjectByCwd` call agree on where things live.
 */
function withProjectHarness<T>(
  callback: (harness: { agentDir: string; projectDir: string }) => T
): T {
  return withHarness(({ agentDir, projectDir }) => {
    const previous = process.env[RUNTIME_AGENT_DIR_ENV]
    process.env[RUNTIME_AGENT_DIR_ENV] = agentDir
    try {
      return callback({ agentDir, projectDir })
    } finally {
      if (previous === undefined) delete process.env[RUNTIME_AGENT_DIR_ENV]
      else process.env[RUNTIME_AGENT_DIR_ENV] = previous
    }
  })
}

function configureProjectRemote(agentDir: string, projectDir: string): void {
  const project = createProject({
    name: 'Demo',
    workingDirectory: projectDir,
    permissionMode: 'ask'
  })
  updateProjectRemoteConnection(project.id, 'conn1', {
    id: 'conn1',
    label: 'Lab HPC',
    host: 'lab-hpc.example.edu',
    username: 'agent',
    privateKeyPath: join(projectDir, 'unused-key')
  })
  updateProjectRemoteDefaults(project.id, {
    defaultRemoteConnectionId: 'conn1',
    remoteWorkspaceRoot: '/cluster/facility/lab/WorkSpace'
  })
}

function writeFastqPair(projectDir: string, sample: string): void {
  mkdirSync(join(projectDir, 'data'), { recursive: true })
  writeFileSync(join(projectDir, 'data', `${sample}_R1.fastq.gz`), 'r1')
  writeFileSync(join(projectDir, 'data', `${sample}_R2.fastq.gz`), 'r2')
}

function fastqQcWrapper(agentDir: string, projectDir: string): WrapperCatalogEntry {
  return installLegacyFastqQcWrapper(agentDir, projectDir)
}

test('createWrapperRunPlan resolves executor "local" when the project has no remote execution configured', () => {
  withHarness(({ agentDir, projectDir }) => {
    writeFastqPair(projectDir, 'S1')
    const wrapper = fastqQcWrapper(agentDir, projectDir)

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
    const wrapper = fastqQcWrapper(agentDir, projectDir)

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
    const wrapper = fastqQcWrapper(agentDir, projectDir)

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
    const wrapper = fastqQcWrapper(agentDir, projectDir)
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

test('createWrapperRunPlan substitutes a resolved absolute path into params.json for a plain single-file input', () => {
  withHarness(({ agentDir, projectDir }) => {
    const wrapper = fastqQcWrapper(agentDir, projectDir)
    const wrapperWithFasta = {
      ...wrapper,
      manifest: {
        ...wrapper.manifest,
        inputs: [
          ...wrapper.manifest.inputs,
          { id: 'fasta', type: 'reference_fasta', required: true }
        ]
      }
    }
    writeFastqPair(projectDir, 'S1')
    mkdirSync(join(projectDir, 'ref'), { recursive: true })
    writeFileSync(join(projectDir, 'ref', 'genome.fa'), '>chr1\nACGT\n')

    const plan = createWrapperRunPlan({
      actor: 'agent',
      wrapper: wrapperWithFasta,
      params: { reads: 'data/*_{R1,R2}.fastq.gz', fasta: 'ref/genome.fa' },
      cwd: projectDir,
      agentDir
    })

    assert.equal(plan.state, 'valid')
    // Nextflow runs with its own cwd, not the project directory the user
    // typed a relative path against — params.json must carry the resolved
    // absolute path, not the raw relative string.
    assert.equal(plan.params.fasta, join(projectDir, 'ref', 'genome.fa'))
    // The raw value the user actually typed is still there for display —
    // resolveLocalInputPath's `userValue`, unaffected by the substitution.
    const fastaInput = plan.inputs.find((input) => input.id === 'fasta')
    assert.equal(fastaInput?.userValue, 'ref/genome.fa')
  })
})

test("createWrapperRunPlan uses a profile's declared nextflowProfile for -profile, not the Phi profile id", () => {
  withHarness(({ agentDir, projectDir }) => {
    const wrapper = fastqQcWrapper(agentDir, projectDir)
    const wrapperWithRenamedProfile = {
      ...wrapper,
      manifest: {
        ...wrapper.manifest,
        engine: {
          ...wrapper.manifest.engine,
          profiles: [{ id: 'local', executor: 'local' as const, nextflowProfile: 'standard' }]
        }
      }
    }
    writeFastqPair(projectDir, 'S1')

    const plan = createWrapperRunPlan({
      actor: 'agent',
      wrapper: wrapperWithRenamedProfile,
      params: { reads: 'data/*_{R1,R2}.fastq.gz' },
      cwd: projectDir,
      agentDir
    })

    assert.equal(plan.profile, 'local')
    assert.equal(plan.nextflowProfile, 'standard')
    assert.match(plan.commandPlan.command, /-profile standard$/)
  })
})

// --- Phase 2: resolveExecutor's "project default" tier -------------------

test('createWrapperRunPlan resolves the sbatch-controller profile when the project has remote execution configured', () => {
  withProjectHarness(({ agentDir, projectDir }) => {
    writeFastqPair(projectDir, 'S1')
    const wrapper = fastqQcWrapper(agentDir, projectDir)
    configureProjectRemote(agentDir, projectDir)

    const plan = createWrapperRunPlan({
      actor: 'agent',
      wrapper,
      params: { reads: 'data/*_{R1,R2}.fastq.gz' },
      cwd: projectDir,
      agentDir
    })

    assert.equal(plan.executor, 'slurm-controller')
    assert.equal(plan.profile, 'slurm-controller')
    assert.equal(plan.state, 'valid')
    assert.match(plan.commandPlan.command, /-profile slurm-controller$/)
  })
})

test("createWrapperRunPlan trusts a remote plan's input paths verbatim — no local existence check, no cwd rewrite", () => {
  withProjectHarness(({ agentDir, projectDir }) => {
    writeFastqPair(projectDir, 'S1')
    const wrapper = fastqQcWrapper(agentDir, projectDir)
    const wrapperWithFasta = {
      ...wrapper,
      manifest: {
        ...wrapper.manifest,
        inputs: [
          ...wrapper.manifest.inputs,
          { id: 'fasta', type: 'reference_fasta', required: true }
        ]
      }
    }
    configureProjectRemote(agentDir, projectDir)
    // Per docs/design/phi-wrapper-product-prd.md's Non-Goals ("Do not
    // auto-sync project data to remote servers"), this path is never
    // expected to exist on this machine — it's where the user already put
    // the reference genome on the remote host themselves.
    const remoteFastaPath = '/cluster/facility/lab/refs/genome.fa'

    const plan = createWrapperRunPlan({
      actor: 'agent',
      wrapper: wrapperWithFasta,
      params: { reads: 'data/*_{R1,R2}.fastq.gz', fasta: remoteFastaPath },
      cwd: projectDir,
      agentDir
    })

    assert.equal(plan.executor, 'slurm-controller')
    assert.equal(plan.state, 'valid', plan.validation.errors.join('; '))
    // Untouched — not resolved against a local cwd, not existence-checked.
    assert.equal(plan.params.fasta, remoteFastaPath)
    const fastaInput = plan.inputs.find((input) => input.id === 'fasta')
    assert.equal(fastaInput?.kind, 'path')
    assert.deepEqual(fastaInput?.localPaths, [])
    assert.deepEqual(fastaInput?.remotePaths, [remoteFastaPath])
  })
})

test('createWrapperRunPlan falls back to local when the project has remote configured but the wrapper declares no sbatch-controller profile', () => {
  withProjectHarness(({ agentDir, projectDir }) => {
    writeFastqPair(projectDir, 'S1')
    const wrapper = fastqQcWrapper(agentDir, projectDir)
    const noRemoteProfileWrapper = {
      ...wrapper,
      manifest: {
        ...wrapper.manifest,
        engine: {
          ...wrapper.manifest.engine,
          profiles: wrapper.manifest.engine.profiles.filter(
            (profile) => profile.executor === 'local'
          )
        }
      }
    }
    configureProjectRemote(agentDir, projectDir)

    const plan = createWrapperRunPlan({
      actor: 'agent',
      wrapper: noRemoteProfileWrapper,
      params: { reads: 'data/*_{R1,R2}.fastq.gz' },
      cwd: projectDir,
      agentDir
    })

    assert.equal(plan.executor, 'local')
  })
})

test('createWrapperRunPlan falls back to local when the project has only partially configured remote execution', () => {
  withProjectHarness(({ agentDir, projectDir }) => {
    writeFastqPair(projectDir, 'S1')
    const wrapper = fastqQcWrapper(agentDir, projectDir)
    const project = createProject({
      name: 'Demo',
      workingDirectory: projectDir,
      permissionMode: 'ask'
    })
    updateProjectRemoteConnection(project.id, 'conn1', {
      id: 'conn1',
      label: 'Lab HPC',
      host: 'lab-hpc.example.edu',
      username: 'agent',
      privateKeyPath: join(projectDir, 'unused-key')
    })
    // defaultRemoteConnectionId set, but remoteWorkspaceRoot never configured.
    updateProjectRemoteDefaults(project.id, { defaultRemoteConnectionId: 'conn1' })

    const plan = createWrapperRunPlan({
      actor: 'agent',
      wrapper,
      params: { reads: 'data/*_{R1,R2}.fastq.gz' },
      cwd: projectDir,
      agentDir
    })

    assert.equal(plan.executor, 'local')
  })
})

test('createWrapperRunPlan does not require heavy-workload acknowledgement once remote execution resolves the wrapper away from local', () => {
  withProjectHarness(({ agentDir, projectDir }) => {
    writeFastqPair(projectDir, 'S1')
    const wrapper = fastqQcWrapper(agentDir, projectDir)
    const heavyWrapper = {
      ...wrapper,
      manifest: { ...wrapper.manifest, resourceClass: 'heavy' as const }
    }
    configureProjectRemote(agentDir, projectDir)

    const plan = createWrapperRunPlan({
      actor: 'agent',
      wrapper: heavyWrapper,
      params: { reads: 'data/*_{R1,R2}.fastq.gz' },
      cwd: projectDir,
      agentDir
    })

    assert.equal(plan.executor, 'slurm-controller')
    assert.equal(plan.requiresHeavyWorkloadAcknowledgement, undefined)
    assert.equal(plan.state, 'valid')
  })
})

test('reviseWrapperRunPlan keeps the same planId and bumps the revision', () => {
  withHarness(({ agentDir, projectDir }) => {
    writeFastqPair(projectDir, 'S1')
    const wrapper = fastqQcWrapper(agentDir, projectDir)

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
