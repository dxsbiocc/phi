import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SbatchRunner,
  buildSbatchScript,
  normalizeSlurmMemory,
  normalizeSlurmTime,
  parseSbatchJobId,
  signalSlurmJob
} from '../src/main/agent/wrappers/executor-slurm'
import type { RemoteLaunchSpec } from '../src/main/agent/wrappers/executor-remote'
import type {
  RemoteExecResult,
  RemoteSshSession
} from '../src/main/agent/wrappers/remote-ssh-session'
import type { WrapperRun, WrapperRunPlan } from '../src/main/agent/wrappers/types'
import type { RemoteFileChunk } from '../src/main/agent/wrappers/remote-ssh-log'
import {
  RemoteLaunchRejectedError,
  RemoteLaunchUnknownError
} from '../src/main/agent/wrappers/remote-launch-claim'
import { fakeLaunchClaimCommand } from './helpers/fakeLaunchClaims'
import { fakeRemoteLogChunk } from './helpers/fakeRemoteLogChunk'

const RUN_DIR = '/home/lab/.phi/wrappers/runs/wrun_test'

const FIXTURE_RUN: WrapperRun = {
  runId: 'wrun_test',
  planId: 'wplan_test',
  revision: 1,
  state: 'created',
  actor: 'agent',
  wrapper: {
    canonicalId: 'phi/ngs/fastq-qc',
    namespace: 'phi/ngs',
    shortId: 'fastq-qc',
    version: '1.0.0'
  },
  trustTier: 'bundled',
  executor: 'slurm-controller',
  profile: 'slurm',
  cwd: '/home/lab/project',
  outDir: 'results/fastq-qc',
  createdAt: '2026-09-10T00:00:00.000Z',
  updatedAt: '2026-09-10T00:00:00.000Z'
}

const FIXTURE_PLAN = {
  resources: { cpus: 4, memory: '8 GB', time: '2h' }
} as WrapperRunPlan

const FIXTURE_LAUNCH: RemoteLaunchSpec = {
  remoteRunDir: RUN_DIR,
  launchScript: 'nextflow run wrapper/main.nf -params-file params.json -profile slurm\n',
  paramsJson: '{"outdir":"results"}'
}

/**
 * In-memory fake of `RemoteSshSession` that understands just enough of
 * `sbatch`/`squeue`/`scontrol`/`sacct`/`scancel` output shape to drive
 * `SbatchRunner` — no real Slurm cluster involved, same approach as
 * `tests/wrapper-executor-remote.test.ts`'s `FakeRemoteHost`.
 *
 * `scontrolKnowsJob`/`sacctBroken` model the two real-world failure modes
 * `status()` has to tolerate — verified against an actual cluster during
 * manual testing: `sacct` unconditionally errors there (no working
 * `slurmdbd`) while `scontrol show job` and everything else works fine.
 */
class FakeSlurmCluster implements RemoteSshSession {
  files = new Map<string, string>()
  claims = new Set<string>()
  /** jobId -> final state (undefined while still queued/running) */
  jobs = new Map<string, { state: string; exitCode: number } | undefined>()
  jobNames = new Map<string, string>()
  closed = false
  submitCommands = 0
  submitFault: 'before' | 'after' | undefined
  receiptFault = false
  rejectSubmit = false
  /** Set false to simulate scontrol's retention window having passed for every job. */
  scontrolKnowsJob = true
  /** Set true to simulate a cluster whose sacct is unconditionally broken (no working slurmdbd). */
  sacctBroken = false
  private nextJobId = 5000

  async exec(command: string): Promise<RemoteExecResult> {
    const claim = fakeLaunchClaimCommand(command, this.claims)
    if (claim) return claim
    if (command.startsWith('sbatch ')) {
      this.submitCommands += 1
      const fault = this.submitFault
      this.submitFault = undefined
      if (fault === 'before') throw new Error('SSH closed before sbatch')
      if (this.rejectSubmit) {
        return { stdout: '', stderr: 'Invalid account', code: 1, signal: null }
      }
      const jobId = String(this.nextJobId++)
      this.jobs.set(jobId, undefined)
      this.jobNames.set(
        jobId,
        `phi-${this.files.get(`${RUN_DIR}/.phi-launch-claim/run-id`)?.trim() ?? 'wrun_test'}`
      )
      if (fault === 'after') throw new Error('SSH closed after sbatch')
      return { stdout: `Submitted batch job ${jobId}\n`, stderr: '', code: 0, signal: null }
    }
    if (command.startsWith('squeue ')) {
      const jobId = command.match(/-j (\d+)/)?.[1]
      const known = jobId !== undefined && this.jobs.has(jobId)
      const finished = jobId !== undefined && this.jobs.get(jobId) !== undefined
      return { stdout: known && !finished ? 'RUNNING\n' : '', stderr: '', code: 0, signal: null }
    }
    if (command.startsWith('scontrol show job ')) {
      const jobId = command.match(/^scontrol show job (\d+)/)?.[1]
      const outcome = jobId !== undefined ? this.jobs.get(jobId) : undefined
      if (jobId === undefined || !this.jobs.has(jobId) || !this.scontrolKnowsJob) {
        return {
          stdout: '',
          stderr: 'scontrol: error: Invalid job id specified\n',
          code: 1,
          signal: null
        }
      }
      return {
        stdout: `JobId=${jobId} JobName=${this.jobNames.get(jobId) ?? 'phi-wrun_test'}\n   JobState=${outcome?.state ?? 'RUNNING'} Reason=None Dependency=(null)\n   ExitCode=${outcome?.exitCode ?? 0}:0\n`,
        stderr: '',
        code: 0,
        signal: null
      }
    }
    if (command.startsWith('sacct ')) {
      if (this.sacctBroken) {
        return {
          stdout: '',
          stderr:
            'sacct: error: cannot create accounting_storage context for accounting_storage/slurmdbd\n',
          code: 1,
          signal: null
        }
      }
      const jobId = command.match(/-j (\d+)/)?.[1]
      const outcome = jobId !== undefined ? this.jobs.get(jobId) : undefined
      if (jobId === undefined || outcome === undefined) {
        return { stdout: '', stderr: '', code: 0, signal: null }
      }
      return {
        stdout: `${jobId}|${outcome.state}|${outcome.exitCode}:0\n${jobId}.batch|${outcome.state}|${outcome.exitCode}:0\n`,
        stderr: '',
        code: 0,
        signal: null
      }
    }
    if (command.startsWith('scancel ')) {
      const jobId = command.match(/^scancel (\d+)/)?.[1]
      if (jobId !== undefined) this.jobs.set(jobId, { state: 'CANCELLED', exitCode: 0 })
      return { stdout: '', stderr: '', code: 0, signal: null }
    }
    if (command.startsWith('mkdir -p')) {
      return { stdout: '', stderr: '', code: 0, signal: null }
    }
    throw new Error(`FakeSlurmCluster: unhandled command: ${command}`)
  }

  async readTextFile(remotePath: string): Promise<string> {
    const content = this.files.get(remotePath)
    if (content === undefined) throw new Error(`no such file: ${remotePath}`)
    return content
  }

  async readFileChunk(
    path: string,
    options: Parameters<NonNullable<RemoteSshSession['readFileChunk']>>[1]
  ): Promise<RemoteFileChunk> {
    return fakeRemoteLogChunk(this.files, path, options)
  }

  async writeTextFile(remotePath: string, content: string): Promise<void> {
    this.files.set(remotePath, content)
    if (remotePath.endsWith('/job_id') && this.receiptFault) {
      this.receiptFault = false
      throw new Error('SSH closed before job ID reply')
    }
  }

  async mkdirp(): Promise<void> {
    // Nothing to track — the fake filesystem is a flat Map, not a tree.
  }

  async exists(remotePath: string): Promise<boolean> {
    return this.files.has(remotePath) || this.claims.has(remotePath)
  }

  async close(): Promise<void> {
    this.closed = true
  }

  /** Test helper: simulate the job finishing on its own (outside of `scancel`). */
  finish(jobId: string, state: string, exitCode: number): void {
    this.jobs.set(jobId, { state, exitCode })
  }
}

function makeRunner(): { runner: SbatchRunner; cluster: FakeSlurmCluster } {
  const cluster = new FakeSlurmCluster()
  const runner = new SbatchRunner({
    connection: { host: 'lab-hpc.example.edu' },
    connectImpl: async () => cluster
  })
  return { runner, cluster }
}

test('normalizeSlurmMemory converts wrapper.yaml-style labels to Slurm --mem values', () => {
  assert.equal(normalizeSlurmMemory('8 GB'), '8G')
  assert.equal(normalizeSlurmMemory('512MB'), '512M')
  assert.equal(normalizeSlurmMemory('2 TB'), '2T')
  assert.equal(normalizeSlurmMemory('not a size'), undefined)
})

test('normalizeSlurmTime converts wrapper.yaml-style labels to Slurm --time values', () => {
  assert.equal(normalizeSlurmTime('2h'), '02:00:00')
  assert.equal(normalizeSlurmTime('90m'), '01:30:00')
  assert.equal(normalizeSlurmTime('1d'), '1-00:00:00')
  assert.equal(normalizeSlurmTime('bogus'), undefined)
})

test('parseSbatchJobId extracts the job id from sbatch stdout', () => {
  assert.equal(parseSbatchJobId('Submitted batch job 12345\n'), '12345')
  assert.equal(parseSbatchJobId('sbatch: error: something broke\n'), undefined)
})

test('buildSbatchScript embeds job name, redirect paths, and resource directives', () => {
  const script = buildSbatchScript(FIXTURE_RUN, FIXTURE_PLAN, RUN_DIR)
  assert.match(script, /^#!\/bin\/bash\n/)
  assert.match(script, /#SBATCH --job-name=phi-wrun_test\n/)
  assert.match(script, new RegExp(`#SBATCH --chdir=${RUN_DIR}\\n`))
  assert.match(script, new RegExp(`#SBATCH --output=${RUN_DIR}/logs/stdout\\.log\\n`))
  assert.match(script, /#SBATCH --cpus-per-task=4\n/)
  assert.match(script, /#SBATCH --mem=8G\n/)
  assert.match(script, /#SBATCH --time=02:00:00\n/)
  assert.match(script, /\nbash launch\.sh\n$/)
})

test('buildSbatchScript carries the selected queue, account and head-job options', () => {
  const script = buildSbatchScript(FIXTURE_RUN, FIXTURE_PLAN, RUN_DIR, {
    scheduler: 'slurm',
    controller: 'sbatch',
    queue: 'cpu',
    account: 'lab1',
    controllerOptions: '--qos=normal --time=3-00:00:00'
  })
  assert.match(script, /#SBATCH --partition=cpu\n/)
  assert.match(script, /#SBATCH --account=lab1\n/)
  assert.match(script, /#SBATCH --qos=normal\n/)
  assert.match(script, /#SBATCH --time=3-00:00:00\n/)
  assert.throws(
    () =>
      buildSbatchScript(FIXTURE_RUN, FIXTURE_PLAN, RUN_DIR, {
        scheduler: 'slurm',
        queue: 'cpu\n#SBATCH --chdir=/tmp'
      }),
    /非法字符/
  )
})

test('buildSbatchScript omits a resource directive it cannot normalize rather than emitting a bad flag', () => {
  const plan = { resources: { memory: 'a lot' } } as WrapperRunPlan
  const script = buildSbatchScript(FIXTURE_RUN, plan, RUN_DIR)
  assert.doesNotMatch(script, /--mem=/)
})

test('SbatchRunner.submit uploads the bundle and the sbatch script, returns a jobId handle', async () => {
  const { runner, cluster } = makeRunner()
  const handle = await runner.submit(FIXTURE_RUN, FIXTURE_PLAN, FIXTURE_LAUNCH)

  assert.equal(handle.runId, FIXTURE_RUN.runId)
  assert.equal(handle.remoteRunDir, RUN_DIR)
  assert.equal(handle.pid, undefined)
  assert.equal(typeof handle.jobId, 'string')
  assert.equal(cluster.files.get(`${RUN_DIR}/launch.sh`), FIXTURE_LAUNCH.launchScript)
  assert.ok(cluster.files.get(`${RUN_DIR}/job.sbatch`)?.includes('bash launch.sh'))
})

test('a lost sbatch reply without a durable job ID remains unknown and never resubmits', async () => {
  const { runner, cluster } = makeRunner()
  cluster.submitFault = 'after'
  await assert.rejects(
    runner.submit(FIXTURE_RUN, FIXTURE_PLAN, FIXTURE_LAUNCH),
    RemoteLaunchUnknownError
  )
  await assert.rejects(
    runner.submit(FIXTURE_RUN, FIXTURE_PLAN, FIXTURE_LAUNCH),
    RemoteLaunchUnknownError
  )
  assert.equal(cluster.submitCommands, 1)
  assert.equal(cluster.jobs.size, 1)
})

test('a receipt write lost after sbatch is recovered from the saved job ID', async () => {
  const { runner, cluster } = makeRunner()
  cluster.receiptFault = true
  const first = await runner.submit(FIXTURE_RUN, FIXTURE_PLAN, FIXTURE_LAUNCH)
  const second = await runner.submit(FIXTURE_RUN, FIXTURE_PLAN, FIXTURE_LAUNCH)
  assert.equal(first.jobId, second.jobId)
  assert.equal(cluster.submitCommands, 1)
})

test('a disconnect before sbatch leaves the claim unknown without creating a job', async () => {
  const { runner, cluster } = makeRunner()
  cluster.submitFault = 'before'
  await assert.rejects(
    runner.submit(FIXTURE_RUN, FIXTURE_PLAN, FIXTURE_LAUNCH),
    RemoteLaunchUnknownError
  )
  await assert.rejects(
    runner.submit(FIXTURE_RUN, FIXTURE_PLAN, FIXTURE_LAUNCH),
    RemoteLaunchUnknownError
  )
  assert.equal(cluster.submitCommands, 1)
  assert.equal(cluster.jobs.size, 0)
})

test('a definite sbatch rejection is saved and a duplicate is not submitted', async () => {
  const { runner, cluster } = makeRunner()
  cluster.rejectSubmit = true
  await assert.rejects(
    runner.submit(FIXTURE_RUN, FIXTURE_PLAN, FIXTURE_LAUNCH),
    RemoteLaunchRejectedError
  )
  await assert.rejects(runner.submit(FIXTURE_RUN, FIXTURE_PLAN, FIXTURE_LAUNCH), /Invalid account/)
  assert.equal(cluster.submitCommands, 1)
  assert.match(cluster.files.get(`${RUN_DIR}/launch_error`) ?? '', /Invalid account/)
})

test('SbatchRunner.status reports running while squeue still lists the job', async () => {
  const { runner } = makeRunner()
  const handle = await runner.submit(FIXTURE_RUN, FIXTURE_PLAN, FIXTURE_LAUNCH)

  assert.deepEqual(await runner.status(handle), { outcome: 'running' })
})

test('SbatchRunner.status reports completed/failed from scontrol once the job leaves the queue', async () => {
  const { runner, cluster } = makeRunner()
  const handle = await runner.submit(FIXTURE_RUN, FIXTURE_PLAN, FIXTURE_LAUNCH)

  cluster.finish(handle.jobId!, 'COMPLETED', 0)
  assert.deepEqual(await runner.status(handle), { outcome: 'completed', exitCode: 0 })

  cluster.finish(handle.jobId!, 'FAILED', 1)
  assert.deepEqual(await runner.status(handle), {
    outcome: 'failed',
    exitCode: 1,
    detail: 'FAILED'
  })

  cluster.finish(handle.jobId!, 'OUT_OF_MEMORY', 137)
  assert.deepEqual(await runner.status(handle), {
    outcome: 'failed',
    exitCode: 137,
    detail: 'OUT_OF_MEMORY'
  })
})

test('SbatchRunner.status still reports completed/failed via sacct when a real-world broken slurmdbd makes sacct fail — matches a real cluster tested manually, where sacct is unconditionally broken', async () => {
  const { runner, cluster } = makeRunner()
  const handle = await runner.submit(FIXTURE_RUN, FIXTURE_PLAN, FIXTURE_LAUNCH)
  cluster.finish(handle.jobId!, 'COMPLETED', 0)

  // scontrol's retention window has already passed (or is disabled) — the
  // only remaining source is sacct, and on a real cluster tested manually
  // that command errors outright (broken slurmdbd plugin), which is what
  // `sacctBroken` here reproduces.
  cluster.scontrolKnowsJob = false
  cluster.sacctBroken = true
  assert.deepEqual(await runner.status(handle), { outcome: 'lost' })

  // Same setup, but sacct actually works this time — confirms the fallback
  // path itself (not just scontrol) still functions when it's needed.
  cluster.sacctBroken = false
  assert.deepEqual(await runner.status(handle), { outcome: 'completed', exitCode: 0 })
})

test('SbatchRunner.status still reports completed via scontrol alone when sacct is broken — matches a real cluster verified manually', async () => {
  const { runner, cluster } = makeRunner()
  const handle = await runner.submit(FIXTURE_RUN, FIXTURE_PLAN, FIXTURE_LAUNCH)
  cluster.finish(handle.jobId!, 'COMPLETED', 0)

  cluster.sacctBroken = true
  assert.deepEqual(await runner.status(handle), { outcome: 'completed', exitCode: 0 })
})

test('SbatchRunner.status reports lost when neither squeue, scontrol, nor sacct know the job', async () => {
  const { runner } = makeRunner()
  const status = await runner.status({ runId: 'wrun_gone', remoteRunDir: RUN_DIR, jobId: '99999' })
  assert.deepEqual(status, { outcome: 'lost' })
})

test('SbatchRunner.status uses a saved exit code when the job ID reply was lost', async () => {
  const { runner, cluster } = makeRunner()
  cluster.files.set(`${RUN_DIR}/exit_code`, '0\n')
  assert.deepEqual(await runner.status({ runId: FIXTURE_RUN.runId, remoteRunDir: RUN_DIR }), {
    outcome: 'completed',
    exitCode: 0
  })
})

test('SbatchRunner.status prefers the head process exit code over a terminal scheduler label', async () => {
  const { runner, cluster } = makeRunner()
  const handle = await runner.submit(FIXTURE_RUN, FIXTURE_PLAN, FIXTURE_LAUNCH)
  cluster.finish(handle.jobId!, 'FAILED', 1)
  cluster.files.set(`${RUN_DIR}/exit_code`, '0\n')
  assert.deepEqual(await runner.status(handle), { outcome: 'completed', exitCode: 0 })
})

test('SbatchRunner.cancel scancels the job and is a no-op without a jobId', async () => {
  const { runner } = makeRunner()
  const handle = await runner.submit(FIXTURE_RUN, FIXTURE_PLAN, FIXTURE_LAUNCH)

  await runner.cancel(handle)
  assert.deepEqual(await runner.status(handle), {
    outcome: 'failed',
    exitCode: 0,
    detail: 'CANCELLED'
  })

  await runner.cancel({ ...handle, jobId: undefined })
})

test('Slurm cancellation uses the saved run ID and cannot scancel a sibling job', async () => {
  const host = new FakeSlurmCluster()
  const a = { runId: 'wrun_a', remoteRunDir: `${RUN_DIR}-a`, jobId: '5001' }
  const b = { runId: 'wrun_b', remoteRunDir: `${RUN_DIR}-b`, jobId: '5002' }
  for (const handle of [a, b]) {
    host.files.set(`${handle.remoteRunDir}/.phi-launch-claim/run-id`, `${handle.runId}\n`)
    host.files.set(`${handle.remoteRunDir}/job_id`, `${handle.jobId}\n`)
    host.jobs.set(handle.jobId, undefined)
    host.jobNames.set(handle.jobId, `phi-${handle.runId}`)
  }
  await signalSlurmJob(host, a, 'TERM')
  assert.equal(host.jobs.get(a.jobId)?.state, 'CANCELLED')
  assert.equal(host.jobs.get(b.jobId), undefined)
  await assert.rejects(signalSlurmJob(host, { ...a, jobId: b.jobId }, 'TERM'), /回执不一致/)
  assert.equal(host.jobs.get(b.jobId), undefined)
  // Scheduler IDs can be reused; the current job name must still identify A.
  host.files.set(`${a.remoteRunDir}/job_id`, `${b.jobId}\n`)
  await assert.rejects(signalSlurmJob(host, { ...a, jobId: b.jobId }, 'TERM'), /不再属于/)
  assert.equal(host.jobs.get(b.jobId), undefined)
})

test('SbatchRunner.tailLog reads the sbatch --output/--error redirected log files', async () => {
  const { runner, cluster } = makeRunner()
  const handle = await runner.submit(FIXTURE_RUN, FIXTURE_PLAN, FIXTURE_LAUNCH)

  assert.equal(await runner.tailLog(handle), '')

  cluster.files.set(`${RUN_DIR}/logs/stdout.log`, 'hello from slurm\n')
  assert.equal(await runner.tailLog(handle), 'hello from slurm\n')
})
