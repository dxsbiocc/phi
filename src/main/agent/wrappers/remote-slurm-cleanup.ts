import { posix } from 'node:path'

import type { RemoteSshSession } from './remote-ssh-session'

interface SlurmQueueJob {
  jobId: string
  workDir?: string
}

interface QueueResult {
  ok: boolean
  jobs: SlurmQueueJob[]
}

export interface SlurmRunCleanupOptions {
  scanAttempts?: number
  scanIntervalMs?: number
}

export interface SlurmRunCleanupResult {
  confirmed: boolean
  remainingJobIds: string[]
}

const DEFAULT_SCAN_ATTEMPTS = 3
const DEFAULT_SCAN_INTERVAL_MS = 500
const JOB_ID = /^[1-9][0-9]*(?:_[0-9]+|\+[0-9]+)?$/

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function parseQueue(stdout: string, includesWorkDir: boolean): SlurmQueueJob[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const [jobId, , workDir] = line.split('|').map((field) => field.trim())
      if (!JOB_ID.test(jobId ?? '')) return []
      const usableWorkDir = workDir && workDir !== '%Z' ? workDir : undefined
      return [{ jobId, ...(includesWorkDir && usableWorkDir ? { workDir: usableWorkDir } : {}) }]
    })
}

function queueLineCount(stdout: string): number {
  return stdout.split('\n').filter((line) => line.trim()).length
}

function parseScontrolWorkDir(stdout: string): string | undefined {
  const value = stdout.match(/(?:^|\s)WorkDir=(\S+)/)?.[1]
  return value && value !== '(null)' ? value : undefined
}

async function fillWorkDirs(
  session: RemoteSshSession,
  jobs: SlurmQueueJob[]
): Promise<SlurmQueueJob[]> {
  return Promise.all(
    jobs.map(async (job) => {
      if (job.workDir && job.workDir !== '(null)') return job
      const detail = await session.exec(`scontrol show job ${job.jobId} 2>/dev/null`)
      const workDir = detail.code === 0 ? parseScontrolWorkDir(detail.stdout) : undefined
      return { ...job, ...(workDir ? { workDir } : {}) }
    })
  )
}

async function listUserJobs(session: RemoteSshSession): Promise<QueueResult> {
  const detailed = await session.exec('squeue -u "$USER" -h -o "%i|%T|%Z"')
  if (detailed.code === 0) {
    const jobs = parseQueue(detailed.stdout, true)
    if (jobs.length !== queueLineCount(detailed.stdout)) return { ok: false, jobs: [] }
    return { ok: true, jobs: await fillWorkDirs(session, jobs) }
  }
  const basic = await session.exec('squeue -u "$USER" -h -o "%i|%T"')
  if (basic.code !== 0) return { ok: false, jobs: [] }
  const jobs = parseQueue(basic.stdout, false)
  if (jobs.length !== queueLineCount(basic.stdout)) return { ok: false, jobs: [] }
  return { ok: true, jobs: await fillWorkDirs(session, jobs) }
}

function isRunWorkDir(runDir: string, workDir: string | undefined): boolean {
  if (!workDir?.startsWith('/')) return false
  const root = posix.normalize(`${runDir.replace(/\/+$/, '')}/work`)
  const candidate = posix.normalize(workDir)
  return candidate === root || candidate.startsWith(`${root}/`)
}

function matchingJobs(runDir: string, jobs: SlurmQueueJob[]): SlurmQueueJob[] {
  return jobs.filter((job) => isRunWorkDir(runDir, job.workDir))
}

async function cancelJobs(session: RemoteSshSession, jobs: SlurmQueueJob[]): Promise<void> {
  for (const { jobId } of jobs) await session.exec(`scancel ${jobId} 2>/dev/null`)
}

/** Cancels and then confirms only active jobs whose WorkDir belongs to this run's work tree. */
export async function cleanupSlurmRunJobs(
  session: RemoteSshSession,
  runDir: string,
  options: SlurmRunCleanupOptions = {}
): Promise<SlurmRunCleanupResult> {
  const attempts = Math.max(1, options.scanAttempts ?? DEFAULT_SCAN_ATTEMPTS)
  const intervalMs = Math.max(0, options.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS)
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const listed = await listUserJobs(session)
    if (!listed.ok) return { confirmed: false, remainingJobIds: [] }
    await cancelJobs(session, matchingJobs(runDir, listed.jobs))
    if (attempt + 1 < attempts && intervalMs > 0) await sleep(intervalMs)
  }
  const final = await listUserJobs(session)
  if (!final.ok) return { confirmed: false, remainingJobIds: [] }
  const remainingJobIds = matchingJobs(runDir, final.jobs).map((job) => job.jobId)
  return { confirmed: remainingJobIds.length === 0, remainingJobIds }
}
