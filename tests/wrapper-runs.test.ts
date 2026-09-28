import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
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
import { deleteRemoteHostProfile, saveRemoteHostProfile } from '../src/main/agent/remote-hosts'
import { RUNTIME_AGENT_DIR_ENV } from '../src/main/agent/runtime-paths'
import { createWrapperRunPlan } from '../src/main/agent/wrappers/plans'
import {
  cancelWrapperRun,
  cancelWrapperRunPlan,
  resolveRemoteSubmitOptions,
  submitWrapperRunPlan
} from '../src/main/agent/wrappers/runs'
import type {
  RemoteExecResult,
  RemoteSshSession
} from '../src/main/agent/wrappers/remote-ssh-session'
import {
  getWrapperRunsDir,
  readWrapperPlan,
  readWrapperRun,
  writeWrapperPlan,
  writeWrapperRun
} from '../src/main/agent/wrappers/store'
import type { WrapperCatalogEntry } from '../src/main/agent/wrappers/catalog'
import type { WrapperRun, WrapperRunPlan } from '../src/main/agent/wrappers/types'
import { installLegacyFastqQcWrapper, installLegacyRnaseqWrapper } from './helpers/wrapperFixtures'

function withHarness<T>(callback: (harness: { agentDir: string; projectDir: string }) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'phi-wrapper-runs-'))
  const agentDir = join(root, '.phi-home')
  const projectDir = join(root, 'project')
  mkdirSync(projectDir, { recursive: true })
  try {
    return callback({ agentDir, projectDir })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function withAsyncHarness<T>(
  callback: (harness: { agentDir: string; projectDir: string }) => Promise<T>
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'phi-wrapper-cancel-'))
  const agentDir = join(root, '.phi-home')
  const projectDir = join(root, 'project')
  mkdirSync(projectDir, { recursive: true })
  try {
    return await callback({ agentDir, projectDir })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/**
 * Like `withHarness`, but also points `projects.ts` (which always resolves
 * `getPhiAgentDir()` from `RUNTIME_AGENT_DIR_ENV`, ignoring any explicit
 * `agentDir` argument — unlike every wrapper-storage function) at the same
 * temp dir, so a project created here and a `resolveRemoteSubmitOptions`
 * call passed the matching `agentDir` agree on where things live.
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

function fastqQcWrapper(agentDir: string, projectDir: string): WrapperCatalogEntry {
  return installLegacyFastqQcWrapper(agentDir, projectDir)
}

function writeFastqPair(projectDir: string, sample: string): void {
  mkdirSync(join(projectDir, 'data'), { recursive: true })
  writeFileSync(join(projectDir, 'data', `${sample}_R1.fastq.gz`), 'r1')
  writeFileSync(join(projectDir, 'data', `${sample}_R2.fastq.gz`), 'r2')
}

function registerSshProject(agentDir: string, slurm: boolean): Project {
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
    ...(slurm
      ? {
          remoteConnections: [
            {
              id: 'conn1',
              label: 'Slurm',
              hostProfileId: host.id,
              hpc: { scheduler: 'slurm' as const, controller: 'sbatch' as const }
            }
          ],
          defaultRemoteConnectionId: 'conn1'
        }
      : {})
  }
  writeFileSync(join(agentDir, 'projects.json'), JSON.stringify([project]))
  return project
}

test('SSH project submits ordinary and Slurm plans with durable host bindings', () => {
  for (const slurm of [false, true]) {
    withProjectHarness(({ agentDir, projectDir }) => {
      const project = registerSshProject(agentDir, slurm)
      const wrapper = slurm
        ? fastqQcWrapper(agentDir, projectDir)
        : installLegacyRnaseqWrapper(agentDir, projectDir)
      const plan = createWrapperRunPlan({
        actor: 'agent',
        wrapper,
        params: slurm
          ? { reads: '/data/project/reads/*.fastq.gz' }
          : {
              input: '/data/project/samples.csv',
              fasta: '/data/project/ref.fa',
              gtf: '/data/project/genes.gtf'
            },
        cwd: join(agentDir, 'remote-project-anchors', project.id),
        projectId: project.id,
        agentDir
      })
      assert.equal(plan.state, 'valid', plan.validation.errors.join('; '))
      const run = submitWrapperRunPlan(plan.planId, { agentDir, autoExecute: false })
      assert.equal(run.executor, slurm ? 'slurm-controller' : 'remote-background')
      assert.equal(run.remote?.host, 'lab-hpc')
      assert.equal(run.remote?.projectId, project.id)
      assert.equal(run.remote?.hostProfileId, plan.targetSelection?.hostProfileId)
      assert.equal(run.remote?.workspaceRoot, '/data/project')
      assert.match(run.remote?.runDir ?? '', /^\/data\/project\/wrappers\/runs\/wrun_/)
      assert.equal(run.outDir, `${run.remote?.runDir}/output`)
      assert.equal(run.remote?.outputRoot, run.outDir)
      assert.equal(run.targetReason, plan.targetSelection?.reason)
      assert.deepEqual(run.inputReferences, plan.inputs)
      const restored = readWrapperRun(run.runId, agentDir)!
      const resolved = resolveRemoteSubmitOptions(restored, undefined, agentDir)
      assert.equal('reason' in resolved, false)
      if (!('reason' in resolved)) {
        assert.equal(resolved.connection.host, 'lab-hpc')
        assert.equal(resolved.remoteWorkspaceRoot, '/data/project')
      }
      const otherHost = saveRemoteHostProfile(
        { label: 'Other', hostAlias: 'other-cluster' },
        agentDir
      )
      updateProjectRemoteConnection(project.id, 'other', {
        id: 'other',
        label: 'Other',
        hostProfileId: otherHost.id,
        hpc: { scheduler: 'slurm', controller: 'sbatch' }
      })
      updateProjectRemoteDefaults(project.id, { defaultRemoteConnectionId: 'other' })
      const rebound = resolveRemoteSubmitOptions(restored, undefined, agentDir)
      assert.equal('reason' in rebound, false)
      if (!('reason' in rebound)) assert.equal(rebound.connection.host, 'lab-hpc')
    })
  }
})

test('an external remote output root is shown in the plan and fixed in the submitted run', () => {
  withProjectHarness(({ agentDir, projectDir }) => {
    const project = registerSshProject(agentDir, true)
    const wrapper = fastqQcWrapper(agentDir, projectDir)
    const outputRoot = '/scratch/shared/phi-report-output'
    const plan = createWrapperRunPlan({
      actor: 'agent',
      wrapper,
      params: { reads: '/data/project/reads/*.fastq.gz', outdir: outputRoot },
      cwd: join(agentDir, 'remote-project-anchors', project.id),
      projectId: project.id,
      agentDir
    })
    assert.equal(plan.state, 'valid', plan.validation.errors.join('; '))
    assert.throws(
      () => submitWrapperRunPlan(plan.planId, { agentDir, autoExecute: false }),
      /外部输出目录需要/
    )
    const run = submitWrapperRunPlan(plan.planId, {
      agentDir,
      autoExecute: false,
      externalOutputRoot: outputRoot
    })
    assert.equal(run.outDir, outputRoot)
    assert.equal(run.remote?.outputRoot, outputRoot)
    assert.equal(run.remote?.externalOutputAuthorized, true)
    assert.equal(readWrapperRun(run.runId, agentDir)?.remote?.outputRoot, outputRoot)
  })
})

test('submit refuses a remote plan after its project path or run configuration changes', () => {
  withProjectHarness(({ agentDir, projectDir }) => {
    const project = registerSshProject(agentDir, true)
    const wrapper = fastqQcWrapper(agentDir, projectDir)
    const plan = createWrapperRunPlan({
      actor: 'agent',
      wrapper,
      params: { reads: '/data/project/reads/*.fastq.gz' },
      cwd: join(agentDir, 'remote-project-anchors', project.id),
      projectId: project.id,
      agentDir
    })
    assert.equal(plan.state, 'valid')
    const changed = {
      ...project,
      location: { ...project.location, canonicalRoot: '/data/other-project' }
    }
    writeFileSync(join(agentDir, 'projects.json'), JSON.stringify([changed]))
    assert.throws(
      () => submitWrapperRunPlan(plan.planId, { agentDir, autoExecute: false }),
      /位置或主机已变化/
    )
    writeFileSync(join(agentDir, 'projects.json'), JSON.stringify([project]))
    const changedHpc = {
      ...project,
      remoteConnections: project.remoteConnections?.map((connection) => ({
        ...connection,
        hpc: { scheduler: 'slurm' as const, controller: 'login' as const }
      }))
    }
    writeFileSync(join(agentDir, 'projects.json'), JSON.stringify([changedHpc]))
    assert.throws(
      () => submitWrapperRunPlan(plan.planId, { agentDir, autoExecute: false }),
      /运行方式与计划快照不一致/
    )
    writeFileSync(join(agentDir, 'projects.json'), JSON.stringify([project]))
    writeWrapperPlan({ ...plan, profile: 'local' }, agentDir)
    assert.throws(
      () => submitWrapperRunPlan(plan.planId, { agentDir, autoExecute: false }),
      /Profile 与计划快照不一致/
    )
    assert.equal(readWrapperPlan(plan.planId, agentDir)?.state, 'valid')
  })
})

test('submitWrapperRunPlan creates a durable run and marks the plan submitted', () => {
  withHarness(({ agentDir, projectDir }) => {
    writeFastqPair(projectDir, 'S1')
    const wrapper = fastqQcWrapper(agentDir, projectDir)
    const plan = createWrapperRunPlan({
      actor: 'agent',
      wrapper,
      params: { reads: 'data/*_{R1,R2}.fastq.gz' },
      cwd: projectDir,
      agentDir
    })

    const run = submitWrapperRunPlan(plan.planId, { agentDir, autoExecute: false })
    assert.equal(run.state, 'created')
    assert.equal(run.planId, plan.planId)
    assert.equal(run.wrapper.canonicalId, 'phi/ngs/fastq-qc')

    const updatedPlan = readWrapperPlan(plan.planId, agentDir)
    assert.equal(updatedPlan?.state, 'submitted')
    assert.equal(updatedPlan?.submittedRunId, run.runId)
  })
})

test('submitWrapperRunPlan rejects an invalid plan', () => {
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

    assert.throws(
      () => submitWrapperRunPlan(plan.planId, { agentDir, autoExecute: false }),
      /无法提交/
    )
  })
})

test('submitWrapperRunPlan requires heavy workload acknowledgement first', () => {
  withHarness(({ agentDir, projectDir }) => {
    writeFastqPair(projectDir, 'S1')
    const wrapper = fastqQcWrapper(agentDir, projectDir)
    const heavyWrapper = {
      ...wrapper,
      manifest: { ...wrapper.manifest, resourceClass: 'heavy' as const }
    }
    const plan = createWrapperRunPlan({
      actor: 'agent',
      wrapper: heavyWrapper,
      params: { reads: 'data/*_{R1,R2}.fastq.gz' },
      cwd: projectDir,
      agentDir
    })

    assert.throws(
      () => submitWrapperRunPlan(plan.planId, { agentDir, autoExecute: false }),
      /需要先确认/
    )
    const run = submitWrapperRunPlan(plan.planId, {
      agentDir,
      heavyWorkloadAcknowledged: true,
      autoExecute: false
    })
    assert.equal(run.state, 'created')
  })
})

test('cancelWrapperRunPlan cancels an unsubmitted plan but refuses an already-submitted one', () => {
  withHarness(({ agentDir, projectDir }) => {
    writeFastqPair(projectDir, 'S1')
    const wrapper = fastqQcWrapper(agentDir, projectDir)
    const plan = createWrapperRunPlan({
      actor: 'agent',
      wrapper,
      params: { reads: 'data/*_{R1,R2}.fastq.gz' },
      cwd: projectDir,
      agentDir
    })

    const cancelled = cancelWrapperRunPlan(plan.planId, agentDir)
    assert.equal(cancelled.state, 'cancelled')

    const secondPlan = createWrapperRunPlan({
      actor: 'agent',
      wrapper,
      params: { reads: 'data/*_{R1,R2}.fastq.gz' },
      cwd: projectDir,
      agentDir
    })
    submitWrapperRunPlan(secondPlan.planId, { agentDir, autoExecute: false })
    assert.throws(() => cancelWrapperRunPlan(secondPlan.planId, agentDir), /已提交为运行/)
  })
})

test('cancelWrapperRun cancels a not-yet-running run but refuses an already-running one', () => {
  withHarness(({ agentDir, projectDir }) => {
    writeFastqPair(projectDir, 'S1')
    const wrapper = fastqQcWrapper(agentDir, projectDir)
    const plan = createWrapperRunPlan({
      actor: 'agent',
      wrapper,
      params: { reads: 'data/*_{R1,R2}.fastq.gz' },
      cwd: projectDir,
      agentDir
    })
    const run = submitWrapperRunPlan(plan.planId, { agentDir, autoExecute: false })

    const cancelled = cancelWrapperRun(run.runId, agentDir)
    assert.equal(cancelled.state, 'cancelled')

    const plan2 = createWrapperRunPlan({
      actor: 'agent',
      wrapper,
      params: { reads: 'data/*_{R1,R2}.fastq.gz' },
      cwd: projectDir,
      agentDir
    })
    const run2 = submitWrapperRunPlan(plan2.planId, { agentDir, autoExecute: false })
    // Simulate the executor having moved the run into "running" — cancelling
    // an actually-running *local* process still isn't supported (only
    // slurm-controller's remote cancel is, see the tests below).
    const running = { ...run2, state: 'running' as const }
    writeWrapperRun(running, agentDir)
    assert.throws(
      () => cancelWrapperRun(run2.runId, agentDir),
      /取消正在执行的进程需要对应执行器支持/
    )
  })
})

function slurmControllerPlan(agentDir: string, projectDir: string): WrapperRunPlan {
  writeFastqPair(projectDir, 'S1')
  const wrapper = fastqQcWrapper(agentDir, projectDir)
  const plan = createWrapperRunPlan({
    actor: 'agent',
    wrapper,
    params: { reads: 'data/*_{R1,R2}.fastq.gz' },
    cwd: projectDir,
    agentDir
  })
  // Hand-overridden rather than routed through plans.ts's real resolver
  // (which now CAN produce slurm-controller — see 'submitWrapperRunPlan
  // dispatches a plan.ts-resolved slurm-controller plan end to end' below)
  // so these tests stay independent of whether a project has remote
  // execution configured, and keep exercising runs.ts's dispatch branch in
  // isolation.
  const slurmPlan: WrapperRunPlan = { ...plan, executor: 'slurm-controller', profile: 'slurm' }
  writeWrapperPlan(slurmPlan, agentDir)
  return slurmPlan
}

test('submitWrapperRunPlan rejects an unbound slurm-controller plan before creating a run', () => {
  withHarness(({ agentDir, projectDir }) => {
    const plan = slurmControllerPlan(agentDir, projectDir)

    assert.throws(() => submitWrapperRunPlan(plan.planId, { agentDir }), /缺少项目和服务器快照/)
    assert.equal(readWrapperPlan(plan.planId, agentDir)?.state, 'valid')
  })
})

test('autoExecute false does not bypass an unbound slurm-controller target', () => {
  withHarness(({ agentDir, projectDir }) => {
    const plan = slurmControllerPlan(agentDir, projectDir)

    assert.throws(
      () => submitWrapperRunPlan(plan.planId, { agentDir, autoExecute: false }),
      /缺少项目和服务器快照/
    )
  })
})

function remoteBackgroundPlan(agentDir: string, projectDir: string): WrapperRunPlan {
  writeFastqPair(projectDir, 'S1')
  const wrapper = fastqQcWrapper(agentDir, projectDir)
  const plan = createWrapperRunPlan({
    actor: 'agent',
    wrapper,
    params: { reads: 'data/*_{R1,R2}.fastq.gz' },
    cwd: projectDir,
    agentDir
  })
  // Hand-overridden — plans.ts's resolver never produces `remote-background`
  // (only `slurm-controller`), same situation slurmControllerPlan() was in
  // before Phase 2's resolver chain existed. Keeps these tests exercising
  // runs.ts's dispatch branch in isolation.
  const remotePlan: WrapperRunPlan = {
    ...plan,
    executor: 'remote-background',
    profile: 'remote-background'
  }
  writeWrapperPlan(remotePlan, agentDir)
  return remotePlan
}

test('submitWrapperRunPlan rejects an unbound remote-background plan', () => {
  withHarness(({ agentDir, projectDir }) => {
    const plan = remoteBackgroundPlan(agentDir, projectDir)

    assert.throws(() => submitWrapperRunPlan(plan.planId, { agentDir }), /缺少项目和服务器快照/)
  })
})

test('autoExecute false does not bypass an unbound remote-background target', () => {
  withHarness(({ agentDir, projectDir }) => {
    const plan = remoteBackgroundPlan(agentDir, projectDir)

    assert.throws(
      () => submitWrapperRunPlan(plan.planId, { agentDir, autoExecute: false }),
      /缺少项目和服务器快照/
    )
  })
})

test('submitWrapperRunPlan dispatches a plan.ts-resolved slurm-controller plan end to end', () => {
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
      hostProfileId: host.id,
      hpc: { scheduler: 'slurm', controller: 'sbatch' },
      inputPathMapping: { localRoot: projectDir, remoteRoot: '/cluster/project-data' }
    })
    updateProjectRemoteDefaults(project.id, {
      defaultRemoteConnectionId: 'conn1',
      remoteWorkspaceRoot: '/cluster/facility/lab/WorkSpace'
    })

    // Unlike slurmControllerPlan() above, this plan comes from the real
    // resolveExecutor() path (no hand-override) — proving plans.ts's
    // resolver and runs.ts's dispatch branch actually connect end to end.
    // A local project stays local unless remote execution is explicitly
    // requested (see plans.ts's resolvePlanTarget), so this plan asks for
    // remote explicitly and lets the project's default connection resolve
    // the rest.
    const plan = createWrapperRunPlan({
      actor: 'agent',
      wrapper,
      params: { reads: 'data/*_{R1,R2}.fastq.gz' },
      cwd: projectDir,
      agentDir,
      explicitTarget: 'remote'
    })
    assert.equal(plan.executor, 'slurm-controller')

    const run = submitWrapperRunPlan(plan.planId, { agentDir, autoExecute: false })
    assert.equal(run.state, 'created')
    assert.equal(run.executor, 'slurm-controller')
    assert.equal(run.planId, plan.planId)
  })
})

function slurmControllerRunFixture(plan: WrapperRunPlan, cwd: string): WrapperRun {
  const now = new Date().toISOString()
  return {
    runId: `wrun_${randomUUID()}`,
    planId: plan.planId,
    revision: plan.revision,
    state: 'created',
    actor: plan.actor,
    wrapper: plan.wrapper,
    trustTier: plan.trustTier,
    executor: 'slurm-controller',
    profile: plan.profile,
    cwd,
    outDir: plan.outputDir,
    steps: plan.steps,
    createdAt: now,
    updatedAt: now
  }
}

test('resolveRemoteSubmitOptions prefers an explicit override over the project config', () => {
  withProjectHarness(({ agentDir, projectDir }) => {
    const plan = slurmControllerPlan(agentDir, projectDir)
    const run = slurmControllerRunFixture(plan, projectDir)
    const project = createProject({
      name: 'Demo',
      workingDirectory: projectDir,
      permissionMode: 'ask'
    })
    const host = saveRemoteHostProfile(
      { label: 'Project host', hostAlias: 'project-host.example.edu' },
      agentDir
    )
    updateProjectRemoteConnection(project.id, 'conn1', {
      id: 'conn1',
      label: 'Lab HPC',
      hostProfileId: host.id
    })
    updateProjectRemoteDefaults(project.id, {
      defaultRemoteConnectionId: 'conn1',
      remoteWorkspaceRoot: '/data/lab/.phi'
    })

    const explicit = {
      connection: {
        host: 'explicit-host.example.edu'
      },
      remoteWorkspaceRoot: '/explicit/root'
    }
    const resolved = resolveRemoteSubmitOptions(run, explicit, agentDir)

    assert.equal('reason' in resolved, false)
    if (!('reason' in resolved)) {
      assert.equal(resolved.connection.host, 'explicit-host.example.edu')
      assert.equal(resolved.remoteWorkspaceRoot, '/explicit/root')
    }
  })
})

test('resolveRemoteSubmitOptions falls back to the run project saved remote config', () => {
  withProjectHarness(({ agentDir, projectDir }) => {
    const plan = slurmControllerPlan(agentDir, projectDir)
    const run = slurmControllerRunFixture(plan, projectDir)
    const project = createProject({
      name: 'Demo',
      workingDirectory: projectDir,
      permissionMode: 'ask'
    })
    const host = saveRemoteHostProfile(
      { label: 'Project host', hostAlias: 'project-host.example.edu' },
      agentDir
    )
    updateProjectRemoteConnection(project.id, 'conn1', {
      id: 'conn1',
      label: 'Lab HPC',
      hostProfileId: host.id
    })
    updateProjectRemoteDefaults(project.id, {
      defaultRemoteConnectionId: 'conn1',
      remoteWorkspaceRoot: '/data/lab/.phi'
    })

    const resolved = resolveRemoteSubmitOptions(run, undefined, agentDir)

    assert.equal('reason' in resolved, false)
    if (!('reason' in resolved)) {
      assert.equal(resolved.connection.host, 'project-host.example.edu')
      assert.deepEqual(Object.keys(resolved.connection), ['host'])
      assert.equal(resolved.remoteWorkspaceRoot, '/data/lab/.phi')
    }
  })
})

test('resolveRemoteSubmitOptions reports a generic reason when neither an override nor a project is configured', () => {
  withProjectHarness(({ agentDir, projectDir }) => {
    const plan = slurmControllerPlan(agentDir, projectDir)
    const run = slurmControllerRunFixture(plan, projectDir)
    // No createProject call at all — getProjectByCwd(run.cwd) finds nothing.

    const resolved = resolveRemoteSubmitOptions(run, undefined, agentDir)

    assert.ok('reason' in resolved)
    if ('reason' in resolved) {
      assert.match(resolved.reason, /缺少远程计算目标/)
    }
  })
})

test('resolveRemoteSubmitOptions surfaces the project connection error as the reason when misconfigured', () => {
  withProjectHarness(({ agentDir, projectDir }) => {
    const plan = slurmControllerPlan(agentDir, projectDir)
    const run = slurmControllerRunFixture(plan, projectDir)
    const project = createProject({
      name: 'Demo',
      workingDirectory: projectDir,
      permissionMode: 'ask'
    })
    const host = saveRemoteHostProfile(
      { label: 'Project host', hostAlias: 'project-host.example.edu' },
      agentDir
    )
    updateProjectRemoteConnection(project.id, 'conn1', {
      id: 'conn1',
      label: 'Lab HPC',
      hostProfileId: host.id
    })
    deleteRemoteHostProfile(host.id, agentDir)
    updateProjectRemoteDefaults(project.id, {
      defaultRemoteConnectionId: 'conn1',
      remoteWorkspaceRoot: '/data/lab/.phi'
    })

    const resolved = resolveRemoteSubmitOptions(run, undefined, agentDir)

    assert.ok('reason' in resolved)
    if ('reason' in resolved) {
      assert.match(resolved.reason, /重新配置/)
    }
  })
})

// --- cancelWrapperRun's remote-running dispatch -----------------------------

/** Two tiny scheduler states and the durable identity files used by cancellation. */
class FakeCancelSession implements RemoteSshSession {
  execLog: string[] = []
  closed = false
  cancelled = false
  failSignal = false

  constructor(
    private readonly remoteRunDir: string,
    private readonly runId: string,
    private readonly identifier: string,
    private readonly kind: 'sbatch' | 'detached' = 'sbatch'
  ) {}

  async exec(command: string): Promise<RemoteExecResult> {
    this.execLog.push(command)
    if (this.failSignal && command.startsWith('scancel ')) {
      throw new Error('SSH disconnected before cancellation reply')
    }
    if (command.startsWith('scancel ') || command.startsWith('kill -TERM -')) {
      this.cancelled = true
    }
    if (command.startsWith('kill -0 ')) {
      return {
        stdout: this.cancelled ? 'dead\n' : 'alive\n',
        stderr: '',
        code: 0,
        signal: null
      }
    }
    if (command.startsWith('ps -ww -o args= -p ')) {
      return {
        stdout: `bash ${this.remoteRunDir}/launch.sh\n`,
        stderr: '',
        code: 0,
        signal: null
      }
    }
    const stdout = command.startsWith('squeue ')
      ? this.cancelled
        ? ''
        : 'RUNNING\n'
      : command.startsWith('scontrol show job ')
        ? `JobId=${this.identifier} JobName=phi-${this.runId} JobState=${this.cancelled ? 'CANCELLED' : 'RUNNING'} ExitCode=${this.cancelled ? 1 : 0}:0\n`
        : ''
    return { stdout, stderr: '', code: 0, signal: null }
  }

  async readTextFile(path: string): Promise<string> {
    if (path === `${this.remoteRunDir}/.phi-launch-claim/run-id`) return `${this.runId}\n`
    if (path === `${this.remoteRunDir}/${this.kind === 'sbatch' ? 'job_id' : 'pid'}`) {
      return `${this.identifier}\n`
    }
    throw new Error(`FakeCancelSession: unexpected read ${path}`)
  }

  async writeTextFile(): Promise<void> {
    // SbatchRunner.cancel/close never call this — only exec matters here.
  }

  async mkdirp(): Promise<void> {
    // SbatchRunner.cancel/close never call this — only exec matters here.
  }

  async exists(path: string): Promise<boolean> {
    return (
      path === `${this.remoteRunDir}/.phi-launch-claim` ||
      path === `${this.remoteRunDir}/.phi-launch-claim/run-id` ||
      path === `${this.remoteRunDir}/${this.kind === 'sbatch' ? 'job_id' : 'pid'}`
    )
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

function writeRemoteSnapshotFixture(
  agentDir: string,
  runId: string,
  remoteRunDir: string,
  jobId: string
): void {
  const runDir = join(getWrapperRunsDir(agentDir), runId)
  mkdirSync(runDir, { recursive: true })
  writeFileSync(
    join(runDir, 'remote.snapshot.json'),
    `${JSON.stringify({ remoteRunDir, jobId })}\n`,
    'utf-8'
  )
}

test('cancelWrapperRun leaves a not-yet-running slurm-controller run cancelled immediately, with no remote dispatch', () => {
  withHarness(({ agentDir, projectDir }) => {
    const plan = slurmControllerPlan(agentDir, projectDir)
    const run = slurmControllerRunFixture(plan, projectDir)
    writeWrapperRun(run, agentDir)
    assert.equal(run.state, 'created')

    const cancelled = cancelWrapperRun(run.runId, agentDir)
    assert.equal(cancelled.state, 'cancelled')
  })
})

test('cancelWrapperRun moves a running slurm-controller run to "cancelling" and dispatches a real scancel', async () => {
  await withAsyncHarness(async ({ agentDir, projectDir }) => {
    const plan = slurmControllerPlan(agentDir, projectDir)
    const run = slurmControllerRunFixture(plan, projectDir)
    writeWrapperRun({ ...run, state: 'running' }, agentDir)

    const remoteRunDir = `/cluster/facility/lab/WorkSpace/wrappers/runs/${run.runId}`
    writeRemoteSnapshotFixture(agentDir, run.runId, remoteRunDir, '12345')

    const fakeSession = new FakeCancelSession(remoteRunDir, run.runId, '12345')
    const cancelled = cancelWrapperRun(run.runId, agentDir, {
      connection: { host: 'lab-hpc.example.edu' },
      remoteWorkspaceRoot: '/cluster/facility/lab/WorkSpace',
      connectImpl: async () => fakeSession
    })
    assert.equal(cancelled.state, 'cancelling')
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.ok(fakeSession.execLog.some((command) => command.startsWith('scancel 12345')))
    assert.equal(fakeSession.closed, true)
    assert.ok(readWrapperRun(run.runId, agentDir)?.cancelConfirmedAt)
  })
})

test('cancelWrapperRun targets a detached background run by process group', async () => {
  await withAsyncHarness(async ({ agentDir, projectDir }) => {
    const plan = slurmControllerPlan(agentDir, projectDir)
    const run = {
      ...slurmControllerRunFixture(plan, projectDir),
      executor: 'remote-background' as const
    }
    writeWrapperRun({ ...run, state: 'running' }, agentDir)
    const remoteRunDir = `/cluster/facility/lab/WorkSpace/wrappers/runs/${run.runId}`
    const runDir = join(getWrapperRunsDir(agentDir), run.runId)
    mkdirSync(runDir, { recursive: true })
    writeFileSync(
      join(runDir, 'remote.snapshot.json'),
      JSON.stringify({ remoteRunDir, pid: 31337 })
    )
    const session = new FakeCancelSession(remoteRunDir, run.runId, '31337', 'detached')
    assert.equal(
      cancelWrapperRun(run.runId, agentDir, {
        connection: { host: 'lab-hpc.example.edu' },
        remoteWorkspaceRoot: '/cluster/facility/lab/WorkSpace',
        connectImpl: async () => session
      }).state,
      'cancelling'
    )
    await new Promise((resolve) => setTimeout(resolve, 650))
    assert.ok(session.execLog.some((command) => command.startsWith('kill -TERM -31337')))
    assert.ok(readWrapperRun(run.runId, agentDir)?.cancelConfirmedAt)
  })
})

test('cancelWrapperRun accepts a repeated cancellation without dispatching again', () => {
  withHarness(({ agentDir, projectDir }) => {
    const plan = slurmControllerPlan(agentDir, projectDir)
    const run = slurmControllerRunFixture(plan, projectDir)
    writeWrapperRun({ ...run, state: 'cancelling' }, agentDir)

    assert.equal(cancelWrapperRun(run.runId, agentDir).state, 'cancelling')
  })
})

test('remote cancellation stays unknown after the SSH signal reply is lost', async () => {
  await withAsyncHarness(async ({ agentDir, projectDir }) => {
    const plan = slurmControllerPlan(agentDir, projectDir)
    const run = slurmControllerRunFixture(plan, projectDir)
    writeWrapperRun({ ...run, state: 'running' }, agentDir)
    const remoteRunDir = `/cluster/facility/lab/WorkSpace/wrappers/runs/${run.runId}`
    writeRemoteSnapshotFixture(agentDir, run.runId, remoteRunDir, '12345')
    const session = new FakeCancelSession(remoteRunDir, run.runId, '12345')
    session.failSignal = true

    cancelWrapperRun(run.runId, agentDir, {
      connection: { host: 'lab-hpc.example.edu' },
      remoteWorkspaceRoot: '/cluster/facility/lab/WorkSpace',
      connectImpl: async () => session
    })
    await new Promise((resolve) => setTimeout(resolve, 30))

    const saved = readWrapperRun(run.runId, agentDir)
    assert.equal(saved?.state, 'lost')
    assert.match(saved?.launchDiagnostic ?? '', /取消结果未知/)
    assert.equal(saved?.cancelConfirmedAt, undefined)
  })
})

test('cancelling an already completed remote run is idempotent', () => {
  withHarness(({ agentDir, projectDir }) => {
    const plan = slurmControllerPlan(agentDir, projectDir)
    const run = slurmControllerRunFixture(plan, projectDir)
    writeWrapperRun({ ...run, state: 'completed' }, agentDir)
    assert.equal(cancelWrapperRun(run.runId, agentDir).state, 'completed')
  })
})
