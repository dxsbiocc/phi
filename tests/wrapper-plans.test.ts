import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createProject,
  type Project,
  updateProjectRemoteConnection,
  updateProjectRemoteDefaults
} from '../src/main/agent/projects'
import { saveRemoteHostProfile } from '../src/main/agent/remote-hosts'
import { RUNTIME_AGENT_DIR_ENV } from '../src/main/agent/runtime-paths'
import type { WrapperCatalogEntry } from '../src/main/agent/wrappers/catalog'
import {
  createWrapperRunPlan,
  isWrapperPlanExpired,
  retargetWrapperRunPlan,
  reviseWrapperRunPlan
} from '../src/main/agent/wrappers/plans'
import {
  readGlobalWrapperAuditEvents,
  readWrapperPlan,
  readWrapperPlanArtifact
} from '../src/main/agent/wrappers/store'
import type { WrapperRunPlan } from '../src/main/agent/wrappers/types'
import { installLegacyFastqQcWrapper, installLegacyRnaseqWrapper } from './helpers/wrapperFixtures'

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
  const host = saveRemoteHostProfile(
    { label: 'Lab HPC', hostAlias: 'lab-hpc.example.edu' },
    agentDir
  )
  updateProjectRemoteConnection(project.id, 'conn1', {
    id: 'conn1',
    label: 'Lab HPC',
    hostProfileId: host.id,
    hpc: { scheduler: 'slurm', controller: 'sbatch' },
    inputPathMapping: { localRoot: projectDir, remoteRoot: '/cluster/project-data' }
  })
  updateProjectRemoteDefaults(project.id, {
    defaultRemoteConnectionId: 'conn1',
    remoteWorkspaceRoot: '/cluster/facility/lab/WorkSpace'
  })
}

function registerSshProject(
  agentDir: string,
  hpc?: { scheduler: 'slurm'; controller: 'sbatch' }
): Project {
  const host = saveRemoteHostProfile({ label: 'Cluster', hostAlias: 'lab-hpc' }, agentDir)
  const project: Project = {
    id: 'ssh-project-1',
    name: 'Remote',
    location: {
      kind: 'ssh',
      hostProfileId: host.id,
      remoteRoot: '/server/project-link',
      canonicalRoot: '/data/project'
    },
    workingDirectory: '/server/project-link',
    workingDirectoryRealPath: '/data/project',
    permissionMode: 'ask',
    pathAvailable: true,
    createdAt: '2026-09-24T00:00:00.000Z',
    ...(hpc
      ? {
          remoteConnections: [{ id: 'conn1', label: 'Slurm', hostProfileId: host.id, hpc }],
          defaultRemoteConnectionId: 'conn1'
        }
      : {})
  }
  writeFileSync(join(agentDir, 'projects.json'), JSON.stringify([project]))
  return project
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

// --- Local projects use remote settings only after an explicit remote request. ---

test('a saved server never changes a local project plan into a remote plan by default', () => {
  withProjectHarness(({ agentDir, projectDir }) => {
    writeFastqPair(projectDir, 'S1')
    configureProjectRemote(agentDir, projectDir)

    const plan = createWrapperRunPlan({
      actor: 'agent',
      wrapper: fastqQcWrapper(agentDir, projectDir),
      params: { reads: 'data/*_{R1,R2}.fastq.gz' },
      cwd: projectDir,
      agentDir
    })

    assert.equal(plan.state, 'valid', plan.validation.errors.join('; '))
    assert.equal(plan.executor, 'local')
    assert.equal(plan.targetSelection?.target, 'local')
  })
})

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
      agentDir,
      explicitTarget: 'remote'
    })

    assert.equal(plan.executor, 'slurm-controller', plan.validation.errors.join('; '))
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
      agentDir,
      explicitTarget: 'remote'
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

test('legacy plan maps an explicit local input to the saved server path and retains provenance', () => {
  withProjectHarness(({ agentDir, projectDir }) => {
    configureProjectRemote(agentDir, projectDir)
    writeFastqPair(projectDir, 'S1')
    const plan = createWrapperRunPlan({
      actor: 'agent',
      wrapper: fastqQcWrapper(agentDir, projectDir),
      params: { reads: { source: 'local', path: 'data/*_{R1,R2}.fastq.gz' } },
      cwd: projectDir,
      agentDir,
      explicitTarget: 'remote'
    })
    assert.equal(plan.state, 'valid', plan.validation.errors.join('; '))
    assert.equal(plan.params.reads, '/cluster/project-data/data/*_{R1,R2}.fastq.gz')
    assert.equal(plan.inputs[0]?.source, 'local')
    assert.deepEqual(plan.inputs[0]?.localPaths, [join(projectDir, 'data/*_{R1,R2}.fastq.gz')])
    assert.deepEqual(plan.inputs[0]?.remotePaths, ['/cluster/project-data/data/*_{R1,R2}.fastq.gz'])

    const sameName = join(projectDir, 'data/*_{R1,R2}.fastq.gz')
    const remoteString = createWrapperRunPlan({
      actor: 'agent',
      wrapper: fastqQcWrapper(agentDir, projectDir),
      params: { reads: sameName },
      cwd: projectDir,
      agentDir,
      explicitTarget: 'remote'
    })
    assert.equal(remoteString.state, 'valid')
    assert.equal(remoteString.inputs[0]?.source, 'remote')
    assert.deepEqual(remoteString.inputs[0]?.localPaths, [])
    assert.deepEqual(remoteString.inputs[0]?.remotePaths, [sameName])
  })
})

test('createWrapperRunPlan rejects a configured remote target without a compatible profile', () => {
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
      agentDir,
      explicitTarget: 'remote'
    })

    assert.equal(plan.state, 'invalid')
    assert.match(plan.validation.errors.join('; '), /远程 Profile/)
  })
})

test('createWrapperRunPlan rejects partial remote settings instead of silently running locally', () => {
  withProjectHarness(({ agentDir, projectDir }) => {
    writeFastqPair(projectDir, 'S1')
    const wrapper = fastqQcWrapper(agentDir, projectDir)
    const project = createProject({
      name: 'Demo',
      workingDirectory: projectDir,
      permissionMode: 'ask'
    })
    const host = saveRemoteHostProfile(
      { label: 'Lab HPC', hostAlias: 'lab-hpc.example.edu' },
      agentDir
    )
    updateProjectRemoteConnection(project.id, 'conn1', {
      id: 'conn1',
      label: 'Lab HPC',
      hostProfileId: host.id
    })
    // defaultRemoteConnectionId set, but remoteWorkspaceRoot never configured.
    updateProjectRemoteDefaults(project.id, { defaultRemoteConnectionId: 'conn1' })

    const plan = createWrapperRunPlan({
      actor: 'agent',
      wrapper,
      params: { reads: 'data/*_{R1,R2}.fastq.gz' },
      cwd: projectDir,
      agentDir,
      explicitTarget: 'remote'
    })

    assert.equal(plan.state, 'invalid')
    assert.match(plan.validation.errors.join('; '), /服务器工作目录/)
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
      agentDir,
      explicitTarget: 'remote'
    })

    assert.equal(plan.executor, 'slurm-controller')
    assert.equal(plan.requiresHeavyWorkloadAcknowledgement, undefined)
    assert.equal(plan.state, 'valid')
  })
})

test('SSH project plans use their bound host and canonical path for ordinary SSH and Slurm', () => {
  for (const mode of ['plain', 'slurm'] as const) {
    withProjectHarness(({ agentDir, projectDir }) => {
      const project = registerSshProject(
        agentDir,
        mode === 'slurm' ? { scheduler: 'slurm', controller: 'sbatch' } : undefined
      )
      const wrapper =
        mode === 'slurm'
          ? fastqQcWrapper(agentDir, projectDir)
          : installLegacyRnaseqWrapper(agentDir, projectDir)
      const params =
        mode === 'slurm'
          ? { reads: '/data/project/reads/*_{R1,R2}.fastq.gz' }
          : {
              input: '/data/project/samplesheet.csv',
              fasta: '/data/project/reference.fa',
              gtf: '/data/project/genes.gtf'
            }
      const plan = createWrapperRunPlan({
        actor: 'agent',
        wrapper,
        params,
        cwd: join(agentDir, 'remote-project-anchors', project.id),
        projectId: project.id,
        agentDir
      })
      assert.equal(plan.state, 'valid', plan.validation.errors.join('; '))
      assert.equal(plan.executor, mode === 'slurm' ? 'slurm-controller' : 'remote-background')
      assert.equal(plan.cwd, '/data/project')
      assert.equal(plan.targetSelection?.projectId, project.id)
      assert.equal(
        plan.targetSelection?.hostProfileId,
        project.location.kind === 'ssh' ? project.location.hostProfileId : ''
      )
      assert.equal(plan.targetSelection?.hostAlias, 'lab-hpc')
      assert.equal(plan.targetSelection?.remoteRoot, '/data/project')
      assert.equal(plan.targetSelection?.environmentCheckPending, true)
      assert.equal(plan.requiresHeavyWorkloadAcknowledgement, undefined)
      assert.throws(
        () =>
          retargetWrapperRunPlan(
            {
              planId: plan.planId,
              target: 'local',
              expectedRevision: plan.revision,
              confirmedLocalFallback: true
            },
            agentDir
          ),
        /只有本地项目/
      )
    })
  }
})

test('SSH project without a compatible remote profile is invalid and cannot fall back to local', () => {
  withProjectHarness(({ agentDir, projectDir }) => {
    const project = registerSshProject(agentDir)
    const plan = createWrapperRunPlan({
      actor: 'agent',
      wrapper: fastqQcWrapper(agentDir, projectDir),
      params: { reads: '/data/project/reads/*.fastq.gz' },
      cwd: join(agentDir, 'remote-project-anchors', project.id),
      projectId: project.id,
      agentDir
    })
    assert.equal(plan.state, 'invalid')
    assert.match(plan.validation.errors.join('; '), /远程 Profile/)
    assert.equal(plan.targetSelection, undefined)
  })
})

test('SSH project rejects an explicit local target while a local project may choose it', () => {
  withProjectHarness(({ agentDir, projectDir }) => {
    const remote = registerSshProject(agentDir)
    const wrapper = installLegacyRnaseqWrapper(agentDir, projectDir)
    const refused = createWrapperRunPlan({
      actor: 'agent',
      wrapper,
      params: {
        input: '/data/project/samples.csv',
        fasta: '/data/project/ref.fa',
        gtf: '/data/project/genes.gtf'
      },
      cwd: join(agentDir, 'remote-project-anchors', remote.id),
      projectId: remote.id,
      explicitTarget: 'local',
      agentDir
    })
    assert.equal(refused.state, 'invalid')
    assert.match(refused.validation.errors.join('; '), /不能在本机执行/)
  })
  withProjectHarness(({ agentDir, projectDir }) => {
    configureProjectRemote(agentDir, projectDir)
    writeFastqPair(projectDir, 'S1')
    const local = createWrapperRunPlan({
      actor: 'agent',
      wrapper: fastqQcWrapper(agentDir, projectDir),
      params: { reads: 'data/*_{R1,R2}.fastq.gz' },
      cwd: projectDir,
      explicitTarget: 'local',
      agentDir
    })
    assert.equal(local.state, 'valid', local.validation.errors.join('; '))
    assert.equal(local.executor, 'local')
    assert.equal(local.targetSelection?.target, 'local')
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

test('revising an SSH plan preserves its saved host, profile and project identity', () => {
  withProjectHarness(({ agentDir, projectDir }) => {
    const project = registerSshProject(agentDir)
    const wrapper = installLegacyRnaseqWrapper(agentDir, projectDir)
    const params = {
      input: '/data/project/samples.csv',
      fasta: '/data/project/ref.fa',
      gtf: '/data/project/genes.gtf'
    }
    const cwd = join(agentDir, 'remote-project-anchors', project.id)
    const first = createWrapperRunPlan({
      actor: 'agent',
      wrapper,
      params,
      cwd,
      projectId: project.id,
      agentDir
    })
    assert.equal(first.state, 'valid')
    const revised = reviseWrapperRunPlan(
      first.planId,
      { ...params, aligner: 'hisat2' },
      { actor: 'agent', wrapper, cwd, agentDir }
    )
    assert.equal(revised.revision, 2)
    assert.equal(revised.executor, 'remote-background')
    assert.deepEqual(revised.targetSelection, first.targetSelection)
    assert.throws(
      () =>
        reviseWrapperRunPlan(first.planId, params, {
          actor: 'agent',
          wrapper,
          cwd,
          agentDir,
          explicitTarget: 'local'
        }),
      /需要创建新计划/
    )
    const changed = {
      ...project,
      location: { ...project.location, canonicalRoot: '/data/changed' }
    }
    writeFileSync(join(agentDir, 'projects.json'), JSON.stringify([changed]))
    assert.throws(
      () => reviseWrapperRunPlan(first.planId, params, { actor: 'agent', wrapper, cwd, agentDir }),
      /项目或服务器配置已变化/
    )
    assert.equal(readWrapperPlan(first.planId, agentDir)?.revision, 2)
  })
})

test('local fallback creates a validated revision with an explicit durable confirmation', () => {
  withProjectHarness(({ agentDir, projectDir }) => {
    configureProjectRemote(agentDir, projectDir)
    writeFastqPair(projectDir, 'S1')
    const wrapper = fastqQcWrapper(agentDir, projectDir)
    const remote = createWrapperRunPlan({
      actor: 'agent',
      wrapper,
      params: { reads: 'data/*_{R1,R2}.fastq.gz' },
      cwd: projectDir,
      agentDir,
      explicitTarget: 'remote'
    })
    assert.equal(remote.executor, 'slurm-controller')
    assert.throws(
      () =>
        retargetWrapperRunPlan(
          { planId: remote.planId, target: 'local', expectedRevision: 1 },
          agentDir
        ),
      /需要明确确认/
    )
    const local = retargetWrapperRunPlan(
      {
        planId: remote.planId,
        target: 'local',
        expectedRevision: 1,
        confirmedLocalFallback: true
      },
      agentDir
    )
    assert.equal(local.state, 'valid', local.validation.errors.join('; '))
    assert.equal(local.revision, 2)
    assert.equal(local.executor, 'local')
    assert.equal(local.targetSelection?.target, 'local')
    assert.match(local.targetSelection?.reason ?? '', /用户确认改在本机运行/)
    assert.equal(local.targetChangeConfirmation?.fromRevision, 1)
    assert.ok(local.targetChangeConfirmation?.confirmedAt)
    assert.deepEqual(
      readWrapperPlan(remote.planId, agentDir)?.targetChangeConfirmation,
      local.targetChangeConfirmation
    )
    const audit = readGlobalWrapperAuditEvents(agentDir).find(
      (event) => event.type === 'plan_confirmation_decision' && event.planId === remote.planId
    )
    assert.equal(audit?.actor, 'user')
    assert.equal(audit?.detail?.confirmedLocalFallback, true)
    assert.throws(
      () =>
        retargetWrapperRunPlan(
          { planId: remote.planId, target: 'remote', expectedRevision: 1 },
          agentDir
        ),
      /计划已更新/
    )
    assert.throws(
      () =>
        retargetWrapperRunPlan(
          { planId: remote.planId, target: 'remote', expectedRevision: 2 },
          agentDir
        ),
      /重新创建计划并填写服务器上的输入路径/
    )
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
