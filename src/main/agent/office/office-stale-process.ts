import { execFile } from 'node:child_process'

import { officeCliEnv, runOfficeCli } from './office-driver'
import { fileOwnerPids } from './office-process-discovery'

const PROCESS_POLL_MS = 25
const EXIT_TIMEOUT_MS = 5_000
const TERM_GRACE_MS = 2_000

export interface OfficeProcessCommand {
  readonly pid: number
  readonly command: string
}

interface StaleProcessDependencies {
  readonly fileOwnerPids?: (path: string) => Promise<number[]>
  readonly listProcesses?: () => Promise<readonly OfficeProcessCommand[]>
  readonly close?: () => Promise<void>
  readonly isAlive?: (pid: number) => boolean
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void
  readonly sleep?: (ms: number) => Promise<void>
  readonly exitTimeoutMs?: number
  readonly termGraceMs?: number
}

export class OfficeStaleProcessError extends Error {
  constructor(
    readonly code: 'stale_process_unverified' | 'stale_resident_stuck',
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'OfficeStaleProcessError'
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch {
    // A process that exited between the check and signal is already clean.
  }
}

export function listSystemProcesses(): Promise<readonly OfficeProcessCommand[]> {
  return new Promise((resolve, reject) => {
    execFile(
      '/bin/ps',
      ['-ax', '-o', 'pid=', '-o', 'command='],
      { encoding: 'utf8' },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        resolve(
          stdout
            .split('\n')
            .map((line) => /^\s*(\d+)\s+(.+)$/u.exec(line))
            .filter((match): match is RegExpExecArray => match !== null)
            .map((match) => ({ pid: Number(match[1]), command: match[2]! }))
        )
      }
    )
  })
}

function isExactDraftProcess(command: string, binaryPath: string, draftPath: string): boolean {
  if (command === `${binaryPath} __resident-serve__ ${draftPath}`) return true
  const watch = `${binaryPath} watch ${draftPath}`
  return command === watch || command.startsWith(`${watch} --`)
}

async function closeWithCli(binaryPath: string, draftPath: string): Promise<void> {
  await runOfficeCli(binaryPath, ['close', draftPath, '--json'], {
    timeoutMs: 30_000,
    env: officeCliEnv(process.env, { OFFICECLI_RESIDENT_FLUSH: 'each' })
  })
}

async function waitForExit(
  pids: readonly number[],
  timeoutMs: number,
  isAlive: (pid: number) => boolean,
  sleep: (ms: number) => Promise<void>
): Promise<readonly number[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const alive = pids.filter(isAlive)
    if (alive.length === 0 || Date.now() >= deadline) return alive
    await sleep(PROCESS_POLL_MS)
  }
}

export async function cleanupStaleOfficeProcesses(
  binaryPath: string,
  draftPath: string,
  dependencies: StaleProcessDependencies = {}
): Promise<{ readonly cleanedPids: readonly number[] }> {
  const owners = await (dependencies.fileOwnerPids ?? fileOwnerPids)(draftPath)
  let processes: readonly OfficeProcessCommand[]
  try {
    processes = await (dependencies.listProcesses ?? listSystemProcesses)()
  } catch (error) {
    if (owners.length === 0) return { cleanedPids: [] }
    throw new OfficeStaleProcessError(
      'stale_process_unverified',
      '检测到可能属于该草稿的残留进程，但无法确认，请退出残留进程后重试',
      { cause: error }
    )
  }
  const exact = processes
    .filter((item) => isExactDraftProcess(item.command, binaryPath, draftPath))
    .map((item) => item.pid)
  if (exact.length === 0) return { cleanedPids: [] }
  await (dependencies.close ?? (() => closeWithCli(binaryPath, draftPath)))().catch(() => undefined)
  const alive = dependencies.isAlive ?? processAlive
  const sleep =
    dependencies.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)))
  let remaining = await waitForExit(
    exact,
    dependencies.exitTimeoutMs ?? EXIT_TIMEOUT_MS,
    alive,
    sleep
  )
  for (const pid of remaining) (dependencies.kill ?? signalProcess)(pid, 'SIGTERM')
  remaining = await waitForExit(remaining, dependencies.termGraceMs ?? TERM_GRACE_MS, alive, sleep)
  if (remaining.length > 0) {
    throw new OfficeStaleProcessError(
      'stale_resident_stuck',
      'Office 残留进程未能退出，请退出残留进程后重试'
    )
  }
  return { cleanedPids: exact }
}
