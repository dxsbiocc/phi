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
import { reconcileRemoteWrapperRuns } from '../src/main/agent/wrappers/executor-slurm-reconcile'
import type {
  RemoteExecResult,
  RemoteSshSession
} from '../src/main/agent/wrappers/remote-ssh-session'
import {
  getWrapperRunsDir,
  readWrapperRun,
  writeWrapperRun
} from '../src/main/agent/wrappers/store'
import type { WrapperRun } from '../src/main/agent/wrappers/types'

/**
 * In-memory fake covering exactly the commands `SbatchRunner.status()`/
 * `.cancel()` issue during reconciliation (no `submit()` here — every run
 * in these tests already has a `remote.snapshot.json`, i.e. was already
 * submitted in a prior, now-dead app session).
 */
class FakeSlurmHost implements RemoteSshSession {
  files = new Map<string, string>()
  execLog: string[] = []

  constructor(private readonly outcome: { state: string; exitCode: number } | 'untracked') {}

  async exec(command: string): Promise<RemoteExecResult> {
    this.execLog.push(command)
    if (command.startsWith('squeue ')) {
      return { stdout: '', stderr: '', code: 0, signal: null }
    }
    if (command.startsWith('scontrol show job ')) {
      if (this.outcome === 'untracked') {
        return {
          stdout: '',
          stderr: 'scontrol: error: Invalid job id specified\n',
          code: 1,
          signal: null
        }
      }
      return {
        stdout: `JobId=1 JobName=phi-test\n   JobState=${this.outcome.state} Reason=None\n   ExitCode=${this.outcome.exitCode}:0\n`,
        stderr: '',
        code: 0,
        signal: null
      }
    }
    if (command.startsWith('sacct ')) {
      return { stdout: '', stderr: '', code: 0, signal: null }
    }
    if (command.startsWith('scancel ')) {
      return { stdout: '', stderr: '', code: 0, signal: null }
    }
    throw new Error(`FakeSlurmHost: unhandled command: ${command}`)
  }

  async readTextFile(remotePath: string): Promise<string> {
    const content = this.files.get(remotePath)
    if (content === undefined) throw new Error(`no such file: ${remotePath}`)
    return content
  }

  async writeTextFile(remotePath: string, content: string): Promise<void> {
    this.files.set(remotePath, content)
  }

  async mkdirp(): Promise<void> {
    // Nothing to track — the fake filesystem is a flat Map, not a tree.
  }

  async exists(remotePath: string): Promise<boolean> {
    return this.files.has(remotePath)
  }

  async close(): Promise<void> {
    // Nothing to release — no real connection was ever opened.
  }
}

async function withProjectHarness<T>(
  callback: (harness: { agentDir: string; projectDir: string }) => Promise<T>
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'phi-wrapper-slurm-reconcile-'))
  const agentDir = join(root, '.phi-home')
  const projectDir = join(root, 'project')
  mkdirSync(projectDir, { recursive: true })
  const previous = process.env[RUNTIME_AGENT_DIR_ENV]
  process.env[RUNTIME_AGENT_DIR_ENV] = agentDir
  try {
    return await callback({ agentDir, projectDir })
  } finally {
    if (previous === undefined) delete process.env[RUNTIME_AGENT_DIR_ENV]
    else process.env[RUNTIME_AGENT_DIR_ENV] = previous
    rmSync(root, { recursive: true, force: true })
  }
}

function configureProjectRemote(agentDir: string, projectDir: string): void {
  const project = createProject({
    name: 'Demo',
    workingDirectory: projectDir,
    permissionMode: 'ask'
  })
  const keyPath = join(projectDir, 'id_ed25519')
  writeFileSync(keyPath, 'FAKE-KEY', 'utf-8')
  updateProjectRemoteConnection(project.id, 'conn1', {
    id: 'conn1',
    label: 'Lab HPC',
    host: 'lab-hpc.example.edu',
    username: 'agent',
    privateKeyPath: keyPath
  })
  updateProjectRemoteDefaults(project.id, {
    defaultRemoteConnectionId: 'conn1',
    remoteWorkspaceRoot: '/cluster/facility/lab/WorkSpace'
  })
}

function writeSlurmControllerRun(
  agentDir: string,
  projectDir: string,
  overrides: Partial<WrapperRun> = {}
): WrapperRun {
  ensureBundledWrappersInstalled(agentDir)
  const entry = listWrapperCatalog(agentDir).find((item) => item.manifest.id === 'phi/ngs/fastq-qc')
  if (!entry) throw new Error('fastq-qc fixture not installed')
  const now = new Date().toISOString()
  const run: WrapperRun = {
    runId: `wrun_${randomUUID()}`,
    planId: `wplan_${randomUUID()}`,
    revision: 1,
    state: 'running',
    actor: 'agent',
    wrapper: {
      canonicalId: entry.manifest.id,
      namespace: entry.manifest.id.split('/').slice(0, -1).join('/'),
      shortId: entry.manifest.shortId,
      version: entry.manifest.version
    },
    trustTier: entry.trustTier,
    executor: 'slurm-controller',
    profile: 'slurm-controller',
    cwd: projectDir,
    outDir: 'results/phi-wrapper/fastq-qc',
    createdAt: now,
    updatedAt: now,
    ...overrides
  }
  writeWrapperRun(run, agentDir)
  return run
}

function writeRemoteSnapshot(
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

test('reconcileRemoteWrapperRuns finalizes a running run whose remote job already completed', () =>
  withProjectHarness(async ({ agentDir, projectDir }) => {
    configureProjectRemote(agentDir, projectDir)
    const run = writeSlurmControllerRun(agentDir, projectDir)
    const remoteRunDir = `/cluster/facility/lab/WorkSpace/wrappers/runs/${run.runId}`
    writeRemoteSnapshot(agentDir, run.runId, remoteRunDir, '999')
    const cluster = new FakeSlurmHost({ state: 'COMPLETED', exitCode: 0 })
    cluster.files.set(`${remoteRunDir}/output/results/multiqc_report.html`, '<html></html>')

    await reconcileRemoteWrapperRuns({
      agentDir,
      connectImpl: async () => cluster,
      pollIntervalMs: 1
    })

    const finalRun = readWrapperRun(run.runId, agentDir)
    assert.equal(finalRun?.state, 'completed')
    assert.equal(finalRun?.exitCode, 0)
    const report = finalRun?.outputs?.find((output) => output.id === 'report')
    assert.equal(report?.exists, true)
    assert.equal(report?.location, 'remote')
  }))

test('reconcileRemoteWrapperRuns marks a run lost when there is no remote snapshot to reconnect from', () =>
  withProjectHarness(async ({ agentDir, projectDir }) => {
    configureProjectRemote(agentDir, projectDir)
    const run = writeSlurmControllerRun(agentDir, projectDir)
    // No remote.snapshot.json written — the run never got far enough to submit.

    await reconcileRemoteWrapperRuns({
      agentDir,
      connectImpl: async () => {
        throw new Error('should not attempt to connect without a snapshot')
      }
    })

    assert.equal(readWrapperRun(run.runId, agentDir)?.state, 'lost')
  }))

test('reconcileRemoteWrapperRuns marks a run lost when the project remote config is missing', () =>
  withProjectHarness(async ({ agentDir, projectDir }) => {
    // configureProjectRemote intentionally not called.
    const run = writeSlurmControllerRun(agentDir, projectDir)
    writeRemoteSnapshot(agentDir, run.runId, '/some/remote/dir', '999')

    await reconcileRemoteWrapperRuns({
      agentDir,
      connectImpl: async () => {
        throw new Error('should not attempt to connect without a resolvable remote config')
      }
    })

    assert.equal(readWrapperRun(run.runId, agentDir)?.state, 'lost')
  }))

test('reconcileRemoteWrapperRuns reissues scancel and finalizes a cancelling run as cancelled', () =>
  withProjectHarness(async ({ agentDir, projectDir }) => {
    configureProjectRemote(agentDir, projectDir)
    const run = writeSlurmControllerRun(agentDir, projectDir, { state: 'cancelling' })
    const remoteRunDir = `/cluster/facility/lab/WorkSpace/wrappers/runs/${run.runId}`
    writeRemoteSnapshot(agentDir, run.runId, remoteRunDir, '999')
    const cluster = new FakeSlurmHost({ state: 'CANCELLED', exitCode: 0 })

    await reconcileRemoteWrapperRuns({
      agentDir,
      connectImpl: async () => cluster,
      pollIntervalMs: 1
    })

    const finalRun = readWrapperRun(run.runId, agentDir)
    assert.equal(finalRun?.state, 'cancelled')
    assert.ok(cluster.execLog.some((command) => command.startsWith('scancel 999')))
  }))

test('reconcileRemoteWrapperRuns leaves already-terminal and non-slurm-controller runs untouched', () =>
  withProjectHarness(async ({ agentDir, projectDir }) => {
    configureProjectRemote(agentDir, projectDir)
    const completedRun = writeSlurmControllerRun(agentDir, projectDir, {
      state: 'completed',
      completedAt: new Date().toISOString()
    })
    const localRun = writeSlurmControllerRun(agentDir, projectDir, {
      executor: 'local',
      profile: 'local',
      state: 'running'
    })

    await reconcileRemoteWrapperRuns({
      agentDir,
      connectImpl: async () => {
        throw new Error('should not attempt to connect for skipped runs')
      }
    })

    assert.equal(readWrapperRun(completedRun.runId, agentDir)?.state, 'completed')
    assert.equal(readWrapperRun(localRun.runId, agentDir)?.state, 'running')
  }))
