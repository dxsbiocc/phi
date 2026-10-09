import assert from 'node:assert/strict'
import test from 'node:test'

import { cancelRemoteController } from '../src/main/agent/wrappers/remote-cancel'
import type {
  RemoteExecResult,
  RemoteSshSession
} from '../src/main/agent/wrappers/remote-ssh-session'

const runDir = '/remote/wrappers/runs/wrun_a'
const handle = { runId: 'wrun_a', remoteRunDir: runDir, pid: 4242 }

class StubbornDetachedHost implements RemoteSshSession {
  commands: string[] = []
  alive = true
  exitCode: string | undefined

  async exec(command: string): Promise<RemoteExecResult> {
    this.commands.push(command)
    if (command.startsWith('kill -KILL -')) this.alive = false
    return {
      stdout: command.startsWith('kill -0 ')
        ? this.alive
          ? 'alive\n'
          : 'dead\n'
        : command.startsWith('ps -ww -o args= -p ')
          ? `bash ${runDir}/launch.sh\n`
          : '',
      stderr: '',
      code: 0,
      signal: null
    }
  }

  async readTextFile(path: string): Promise<string> {
    if (path === `${runDir}/.phi-launch-claim/run-id`) return 'wrun_a\n'
    if (path === `${runDir}/pid`) return '4242\n'
    if (path === `${runDir}/exit_code` && this.exitCode !== undefined) return this.exitCode
    throw new Error(`unexpected read: ${path}`)
  }

  async writeTextFile(): Promise<void> {
    // Cancellation never writes remote files.
  }
  async mkdirp(): Promise<void> {
    // Cancellation never creates remote directories.
  }
  async uploadFile(): Promise<void> {
    // Cancellation never uploads files.
  }
  async exists(path: string): Promise<boolean> {
    return (
      path === `${runDir}/.phi-launch-claim/run-id` ||
      path === `${runDir}/pid` ||
      (path === `${runDir}/exit_code` && this.exitCode !== undefined)
    )
  }
  async close(): Promise<void> {
    // No transport to close in the fake.
  }
}

test('remote cancellation escalates TERM to KILL only after the grace period', async () => {
  const host = new StubbornDetachedHost()
  const result = await cancelRemoteController(host, handle, 0)
  assert.equal(result.kind, 'confirmed')
  const term = host.commands.findIndex((command) => command.startsWith('kill -TERM -4242'))
  const kill = host.commands.findIndex((command) => command.startsWith('kill -KILL -4242'))
  assert.ok(term >= 0 && kill > term)
})

test('cancel of an already finished remote process sends no signal', async () => {
  const host = new StubbornDetachedHost()
  host.exitCode = '0\n'
  const result = await cancelRemoteController(host, handle, 0)
  assert.equal(result.kind, 'already-ended')
  assert.ok(host.commands.every((command) => !command.startsWith('kill -TERM -')))
})

class StubbornSlurmHost implements RemoteSshSession {
  commands: string[] = []
  running = true

  async exec(command: string): Promise<RemoteExecResult> {
    this.commands.push(command)
    if (command.startsWith('scancel 4242 ') && !command.includes('--signal=TERM')) {
      this.running = false
    }
    if (command.startsWith('squeue ')) {
      return { stdout: this.running ? 'RUNNING\n' : '', stderr: '', code: 0, signal: null }
    }
    if (command.startsWith('scontrol show job ')) {
      return {
        stdout: `JobId=4242 JobName=phi-wrun_a JobState=${this.running ? 'RUNNING' : 'CANCELLED'} ExitCode=0:0\n`,
        stderr: '',
        code: 0,
        signal: null
      }
    }
    return { stdout: '', stderr: '', code: 0, signal: null }
  }

  async readTextFile(path: string): Promise<string> {
    if (path === `${runDir}/.phi-launch-claim/run-id`) return 'wrun_a\n'
    if (path === `${runDir}/job_id`) return '4242\n'
    throw new Error(`unexpected read: ${path}`)
  }
  async writeTextFile(): Promise<void> {
    // Cancellation never writes remote files.
  }
  async mkdirp(): Promise<void> {
    // Cancellation never creates remote directories.
  }
  async uploadFile(): Promise<void> {
    // Cancellation never uploads files.
  }
  async exists(path: string): Promise<boolean> {
    return path === `${runDir}/.phi-launch-claim/run-id` || path === `${runDir}/job_id`
  }
  async close(): Promise<void> {
    // No transport to close in the fake.
  }
}

test('sbatch cancellation gives the Nextflow process TERM before cancelling the job', async () => {
  const host = new StubbornSlurmHost()
  const result = await cancelRemoteController(host, { ...handle, pid: undefined, jobId: '4242' }, 0)
  assert.equal(result.kind, 'confirmed')
  const term = host.commands.findIndex(
    (command) => command === 'scancel 4242 --full --signal=TERM 2>/dev/null'
  )
  const cancel = host.commands.findIndex((command) => command === 'scancel 4242 2>/dev/null')
  assert.ok(term >= 0 && cancel > term, host.commands.join('\n'))
})

class SlurmWorkDirHost extends StubbornSlurmHost {
  readonly jobs = new Map([
    ['4243', `${runDir}/work/ab/cd`],
    ['4244', '/remote/wrappers/runs/wrun_b/work/ef/gh'],
    ['4245', `${runDir}/work-other/ij/kl`],
    ['4246', '/scratch/manual-job']
  ])

  override async exec(command: string): Promise<RemoteExecResult> {
    if (command === 'squeue -u "$USER" -h -o "%i|%T|%Z"') {
      this.commands.push(command)
      return {
        stdout: [...this.jobs].map(([id, workDir]) => `${id}|RUNNING|${workDir}`).join('\n'),
        stderr: '',
        code: 0,
        signal: null
      }
    }
    const cancelled = command.match(/^scancel (\d+) 2>\/dev\/null$/)?.[1]
    if (cancelled && cancelled !== '4242') this.jobs.delete(cancelled)
    return super.exec(command)
  }
}

test('Slurm cleanup cancels only jobs whose WorkDir is inside this run work directory', async () => {
  const host = new SlurmWorkDirHost()
  const result = await cancelRemoteController(
    host,
    { ...handle, pid: undefined, jobId: '4242' },
    0,
    { cleanupSlurmJobs: true, scanAttempts: 2, scanIntervalMs: 0 }
  )
  assert.equal(result.kind, 'confirmed')
  assert.equal(host.jobs.has('4243'), false)
  assert.deepEqual([...host.jobs.keys()], ['4244', '4245', '4246'])
})

class LegacySqueueHost extends SlurmWorkDirHost {
  override async exec(command: string): Promise<RemoteExecResult> {
    if (command === 'squeue -u "$USER" -h -o "%i|%T|%Z"') {
      this.commands.push(command)
      return { stdout: '', stderr: 'Invalid job format specification', code: 1, signal: null }
    }
    if (command === 'squeue -u "$USER" -h -o "%i|%T"') {
      this.commands.push(command)
      return {
        stdout: [...this.jobs.keys()].map((id) => `${id}|RUNNING`).join('\n'),
        stderr: '',
        code: 0,
        signal: null
      }
    }
    const detailId = command.match(/^scontrol show job (\d+) 2>\/dev\/null$/)?.[1]
    if (detailId && this.jobs.has(detailId)) {
      this.commands.push(command)
      return {
        stdout: `JobId=${detailId} JobState=RUNNING WorkDir=${this.jobs.get(detailId)}\n`,
        stderr: '',
        code: 0,
        signal: null
      }
    }
    return super.exec(command)
  }
}

test('Slurm cleanup falls back to scontrol when squeue does not support WorkDir', async () => {
  const host = new LegacySqueueHost()
  const result = await cancelRemoteController(
    host,
    { ...handle, pid: undefined, jobId: '4242' },
    0,
    { cleanupSlurmJobs: true, scanAttempts: 1, scanIntervalMs: 0 }
  )
  assert.equal(result.kind, 'confirmed')
  assert.equal(host.jobs.has('4243'), false)
  assert.ok(host.commands.includes('scontrol show job 4243 2>/dev/null'))
})

class UncancellableWorkDirHost extends SlurmWorkDirHost {
  override async exec(command: string): Promise<RemoteExecResult> {
    if (command === 'scancel 4243 2>/dev/null') {
      this.commands.push(command)
      return { stdout: '', stderr: '', code: 0, signal: null }
    }
    return super.exec(command)
  }
}

test('Slurm cleanup reports residual job IDs instead of claiming a clean cancellation', async () => {
  const host = new UncancellableWorkDirHost()
  const result = await cancelRemoteController(
    host,
    { ...handle, pid: undefined, jobId: '4242' },
    0,
    { cleanupSlurmJobs: true, scanAttempts: 2, scanIntervalMs: 0 }
  )
  assert.equal(result.kind, 'unknown')
  assert.deepEqual(result.remainingJobIds, ['4243'])
  assert.match(result.message ?? '', /4243/)
  assert.doesNotMatch(result.message ?? '', /\/remote\//)
})

class DetachedSlurmWorkDirHost extends StubbornDetachedHost {
  readonly jobs = new Map([
    ['4243', `${runDir}/work/ab/cd`],
    ['4244', '/remote/wrappers/runs/wrun_b/work/ef/gh']
  ])

  override async exec(command: string): Promise<RemoteExecResult> {
    if (command === 'squeue -u "$USER" -h -o "%i|%T|%Z"') {
      this.commands.push(command)
      return {
        stdout: [...this.jobs].map(([id, workDir]) => `${id}|RUNNING|${workDir}`).join('\n'),
        stderr: '',
        code: 0,
        signal: null
      }
    }
    const cancelled = command.match(/^scancel (\d+) 2>\/dev\/null$/)?.[1]
    if (cancelled) this.jobs.delete(cancelled)
    return super.exec(command)
  }
}

test('login controller on a Slurm profile also sweeps independent task jobs', async () => {
  const host = new DetachedSlurmWorkDirHost()
  const result = await cancelRemoteController(host, handle, 0, {
    cleanupSlurmJobs: true,
    scanAttempts: 1,
    scanIntervalMs: 0
  })
  assert.equal(result.kind, 'confirmed')
  assert.deepEqual([...host.jobs.keys()], ['4244'])
})

class LateSubmissionHost extends StubbornSlurmHost {
  readonly jobs = new Map<string, string>()
  scans = 0

  override async exec(command: string): Promise<RemoteExecResult> {
    if (command === 'squeue -u "$USER" -h -o "%i|%T|%Z"') {
      this.commands.push(command)
      this.scans += 1
      if (this.scans === 2) this.jobs.set('4247', `${runDir}/work/late/task`)
      return {
        stdout: [...this.jobs].map(([id, workDir]) => `${id}|RUNNING|${workDir}`).join('\n'),
        stderr: '',
        code: 0,
        signal: null
      }
    }
    const cancelled = command.match(/^scancel (\d+) 2>\/dev\/null$/)?.[1]
    if (cancelled && cancelled !== '4242') this.jobs.delete(cancelled)
    return super.exec(command)
  }
}

test('repeated Slurm scans catch a task submitted during controller shutdown', async () => {
  const host = new LateSubmissionHost()
  const result = await cancelRemoteController(
    host,
    { ...handle, pid: undefined, jobId: '4242' },
    0,
    { cleanupSlurmJobs: true, scanAttempts: 2, scanIntervalMs: 0 }
  )
  assert.equal(result.kind, 'confirmed')
  assert.equal(host.jobs.size, 0)
  assert.equal(host.scans, 3, 'two cleanup passes plus one final confirmation')
})

class NoFullSlurmHost extends StubbornSlurmHost {
  override async exec(command: string): Promise<RemoteExecResult> {
    if (command === 'scancel 4242 --full --signal=TERM 2>/dev/null') {
      this.commands.push(command)
      return { stdout: '', stderr: '', code: 1, signal: null }
    }
    return super.exec(command)
  }
}

test('a Slurm client without --full support degrades to cancelling the allocation', async () => {
  const host = new NoFullSlurmHost()
  const result = await cancelRemoteController(host, { ...handle, pid: undefined, jobId: '4242' }, 0)
  assert.equal(result.kind, 'confirmed')
  assert.deepEqual(
    host.commands.filter((command) => command.startsWith('scancel ')),
    ['scancel 4242 --full --signal=TERM 2>/dev/null', 'scancel 4242 2>/dev/null']
  )
})

test('an already-cancelled controller still sweeps tasks after a restart gap', async () => {
  const host = new SlurmWorkDirHost()
  host.running = false
  const result = await cancelRemoteController(
    host,
    { ...handle, pid: undefined, jobId: '4242' },
    0,
    { cleanupSlurmJobs: true, scanAttempts: 1, scanIntervalMs: 0 }
  )
  assert.equal(result.kind, 'confirmed')
  assert.equal(host.jobs.has('4243'), false)
  assert.ok(host.commands.every((command) => !command.includes('--signal=TERM')))
})
