import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SbatchRunner,
  buildSbatchScript,
  normalizeSlurmMemory,
  normalizeSlurmTime,
  parseSbatchJobId
} from '../src/main/agent/wrappers/executor-slurm'
import type { RemoteLaunchSpec } from '../src/main/agent/wrappers/executor-remote'
import type {
  RemoteExecResult,
  RemoteSshSession
} from '../src/main/agent/wrappers/remote-ssh-session'
import type { WrapperRun, WrapperRunPlan } from '../src/main/agent/wrappers/types'

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
 * `sbatch`/`squeue`/`sacct`/`scancel` output shape to drive `SbatchRunner` —
 * no real Slurm cluster involved, same approach as
 * `tests/wrapper-executor-remote.test.ts`'s `FakeRemoteHost`.
 */
class FakeSlurmCluster implements RemoteSshSession {
  files = new Map<string, string>()
  /** jobId -> sacct state (undefined while still queued/running) */
  jobs = new Map<string, { state: string; exitCode: number } | undefined>()
  closed = false
  private nextJobId = 5000

  async exec(command: string): Promise<RemoteExecResult> {
    if (command.startsWith('sbatch ')) {
      const jobId = String(this.nextJobId++)
      this.jobs.set(jobId, undefined)
      return { stdout: `Submitted batch job ${jobId}\n`, stderr: '', code: 0, signal: null }
    }
    if (command.startsWith('squeue ')) {
      const jobId = command.match(/-j (\d+)/)?.[1]
      const known = jobId !== undefined && this.jobs.has(jobId)
      const finished = jobId !== undefined && this.jobs.get(jobId) !== undefined
      return { stdout: known && !finished ? 'RUNNING\n' : '', stderr: '', code: 0, signal: null }
    }
    if (command.startsWith('sacct ')) {
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
    connection: { host: 'lab-hpc.example.edu', username: 'agent', privateKey: 'fake' },
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

test('SbatchRunner.status reports running while squeue still lists the job', async () => {
  const { runner } = makeRunner()
  const handle = await runner.submit(FIXTURE_RUN, FIXTURE_PLAN, FIXTURE_LAUNCH)

  assert.deepEqual(await runner.status(handle), { outcome: 'running' })
})

test('SbatchRunner.status reports completed/failed from sacct once the job leaves the queue', async () => {
  const { runner, cluster } = makeRunner()
  const handle = await runner.submit(FIXTURE_RUN, FIXTURE_PLAN, FIXTURE_LAUNCH)

  cluster.finish(handle.jobId!, 'COMPLETED', 0)
  assert.deepEqual(await runner.status(handle), { outcome: 'completed', exitCode: 0 })

  cluster.finish(handle.jobId!, 'FAILED', 1)
  assert.deepEqual(await runner.status(handle), { outcome: 'failed', exitCode: 1 })

  cluster.finish(handle.jobId!, 'OUT_OF_MEMORY', 137)
  assert.deepEqual(await runner.status(handle), { outcome: 'failed', exitCode: 137 })
})

test('SbatchRunner.status reports lost when neither squeue nor sacct know the job', async () => {
  const { runner } = makeRunner()
  const status = await runner.status({ runId: 'wrun_gone', remoteRunDir: RUN_DIR, jobId: '99999' })
  assert.deepEqual(status, { outcome: 'lost' })
})

test('SbatchRunner.cancel scancels the job and is a no-op without a jobId', async () => {
  const { runner } = makeRunner()
  const handle = await runner.submit(FIXTURE_RUN, FIXTURE_PLAN, FIXTURE_LAUNCH)

  await runner.cancel(handle)
  assert.deepEqual(await runner.status(handle), { outcome: 'failed', exitCode: 0 })

  await runner.cancel({ ...handle, jobId: undefined })
})

test('SbatchRunner.tailLog reads the sbatch --output/--error redirected log files', async () => {
  const { runner, cluster } = makeRunner()
  const handle = await runner.submit(FIXTURE_RUN, FIXTURE_PLAN, FIXTURE_LAUNCH)

  assert.equal(await runner.tailLog(handle), '')

  cluster.files.set(`${RUN_DIR}/logs/stdout.log`, 'hello from slurm\n')
  assert.equal(await runner.tailLog(handle), 'hello from slurm\n')
})
