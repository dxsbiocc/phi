import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
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
import {
  ensureBundledWrappersInstalled,
  listWrapperCatalog
} from '../src/main/agent/wrappers/catalog'
import { createWrapperRunPlan } from '../src/main/agent/wrappers/plans'
import {
  cancelWrapperRun,
  cancelWrapperRunPlan,
  resolveRemoteSubmitOptions,
  submitWrapperRunPlan
} from '../src/main/agent/wrappers/runs'
import {
  readWrapperPlan,
  readWrapperRun,
  writeWrapperPlan,
  writeWrapperRun
} from '../src/main/agent/wrappers/store'
import type { WrapperCatalogEntry } from '../src/main/agent/wrappers/catalog'
import type { WrapperRun, WrapperRunPlan } from '../src/main/agent/wrappers/types'

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

function fastqQcWrapper(agentDir: string): WrapperCatalogEntry {
  ensureBundledWrappersInstalled(agentDir)
  const entry = listWrapperCatalog(agentDir).find((item) => item.manifest.id === 'phi/ngs/fastq-qc')
  if (!entry) throw new Error('fastq-qc fixture not installed')
  return entry
}

function writeFastqPair(projectDir: string, sample: string): void {
  mkdirSync(join(projectDir, 'data'), { recursive: true })
  writeFileSync(join(projectDir, 'data', `${sample}_R1.fastq.gz`), 'r1')
  writeFileSync(join(projectDir, 'data', `${sample}_R2.fastq.gz`), 'r2')
}

test('submitWrapperRunPlan creates a durable run and marks the plan submitted', () => {
  withHarness(({ agentDir, projectDir }) => {
    writeFastqPair(projectDir, 'S1')
    const wrapper = fastqQcWrapper(agentDir)
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
    const wrapper = fastqQcWrapper(agentDir)
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
    const wrapper = fastqQcWrapper(agentDir)
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
    const wrapper = fastqQcWrapper(agentDir)
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
    const wrapper = fastqQcWrapper(agentDir)
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
    // Simulate the executor having moved the run into "running" (P1.7 territory).
    const running = { ...run2, state: 'running' as const }
    writeWrapperRun(running, agentDir)
    assert.throws(() => cancelWrapperRun(run2.runId, agentDir), /P1\.7/)
  })
})

function slurmControllerPlan(agentDir: string, projectDir: string): WrapperRunPlan {
  writeFastqPair(projectDir, 'S1')
  const wrapper = fastqQcWrapper(agentDir)
  const plan = createWrapperRunPlan({
    actor: 'agent',
    wrapper,
    params: { reads: 'data/*_{R1,R2}.fastq.gz' },
    cwd: projectDir,
    agentDir
  })
  // plans.ts always produces executor: 'local' (Phase 2's resolver chain
  // isn't built yet) — hand-override it, same as the executor-slurm-submit
  // tests, to exercise the slurm-controller dispatch branch in runs.ts.
  const slurmPlan: WrapperRunPlan = { ...plan, executor: 'slurm-controller', profile: 'slurm' }
  writeWrapperPlan(slurmPlan, agentDir)
  return slurmPlan
}

test('submitWrapperRunPlan fails a slurm-controller run immediately when remote connection info is missing', () => {
  withHarness(({ agentDir, projectDir }) => {
    const plan = slurmControllerPlan(agentDir, projectDir)

    const run = submitWrapperRunPlan(plan.planId, { agentDir })
    // The synchronous return is always the freshly-created record — the
    // failure (like local's) lands via a background write, same contract
    // as runLocalWrapperExecution's failure path.
    assert.equal(run.state, 'created')

    const failed = readWrapperRun(run.runId, agentDir)
    assert.equal(failed?.state, 'failed')
  })
})

test('submitWrapperRunPlan leaves a slurm-controller run at "created" when autoExecute is false', () => {
  withHarness(({ agentDir, projectDir }) => {
    const plan = slurmControllerPlan(agentDir, projectDir)

    const run = submitWrapperRunPlan(plan.planId, { agentDir, autoExecute: false })
    assert.equal(run.state, 'created')
    assert.equal(run.executor, 'slurm-controller')

    // autoExecute: false must skip dispatch entirely — including the
    // "missing remote connection info" failure path, not just the happy one.
    const stillCreated = readWrapperRun(run.runId, agentDir)
    assert.equal(stillCreated?.state, 'created')
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
    updateProjectRemoteConnection(project.id, 'conn1', {
      id: 'conn1',
      label: 'Lab HPC',
      host: 'project-host.example.edu',
      username: 'agent',
      privateKeyPath: join(projectDir, 'never-read')
    })
    updateProjectRemoteDefaults(project.id, {
      defaultRemoteConnectionId: 'conn1',
      remoteWorkspaceRoot: '/data/lab/.phi'
    })

    const explicit = {
      connection: {
        host: 'explicit-host.example.edu',
        username: 'agent',
        privateKey: 'inline-key'
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
    const keyPath = join(projectDir, 'id_ed25519')
    writeFileSync(keyPath, 'FAKE-KEY', 'utf-8')
    const project = createProject({
      name: 'Demo',
      workingDirectory: projectDir,
      permissionMode: 'ask'
    })
    updateProjectRemoteConnection(project.id, 'conn1', {
      id: 'conn1',
      label: 'Lab HPC',
      host: 'project-host.example.edu',
      username: 'agent',
      privateKeyPath: keyPath
    })
    updateProjectRemoteDefaults(project.id, {
      defaultRemoteConnectionId: 'conn1',
      remoteWorkspaceRoot: '/data/lab/.phi'
    })

    const resolved = resolveRemoteSubmitOptions(run, undefined, agentDir)

    assert.equal('reason' in resolved, false)
    if (!('reason' in resolved)) {
      assert.equal(resolved.connection.host, 'project-host.example.edu')
      assert.equal(resolved.connection.privateKey, 'FAKE-KEY')
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
      assert.match(resolved.reason, /缺少远程连接信息/)
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
    updateProjectRemoteConnection(project.id, 'conn1', {
      id: 'conn1',
      label: 'Lab HPC',
      host: 'project-host.example.edu',
      username: 'agent',
      privateKeyPath: join(projectDir, 'does-not-exist')
    })
    updateProjectRemoteDefaults(project.id, {
      defaultRemoteConnectionId: 'conn1',
      remoteWorkspaceRoot: '/data/lab/.phi'
    })

    const resolved = resolveRemoteSubmitOptions(run, undefined, agentDir)

    assert.ok('reason' in resolved)
    if ('reason' in resolved) {
      assert.match(resolved.reason, /私钥文件/)
    }
  })
})
