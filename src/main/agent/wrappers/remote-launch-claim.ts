import { shellQuote, type RemoteSshSession } from './remote-ssh-session'

export type RemoteLaunchKind = 'detached' | 'sbatch'

export type RemoteLaunchObservation =
  | { kind: 'unclaimed' }
  | { kind: 'started'; pid?: number; jobId?: string; exitCode?: number }
  | { kind: 'rejected'; reason: string }
  | { kind: 'unknown'; reason: string }

const CLAIM_DIR = '.phi-launch-claim'
export const REMOTE_JOB_ID_FILE = 'job_id'
export const REMOTE_LAUNCH_ERROR_FILE = 'launch_error'

function positivePid(raw: string): number | undefined {
  if (!/^[1-9][0-9]*$/.test(raw.trim())) return undefined
  const value = Number(raw.trim())
  return Number.isSafeInteger(value) ? value : undefined
}

async function optionalText(session: RemoteSshSession, path: string): Promise<string | undefined> {
  return (await session.exists(path)) ? session.readTextFile(path) : undefined
}

/** Reads only durable evidence. A claim without a receipt is never permission to relaunch. */
export async function observeRemoteLaunch(
  session: RemoteSshSession,
  remoteRunDir: string,
  runId: string,
  kind: RemoteLaunchKind
): Promise<RemoteLaunchObservation> {
  const claimDir = `${remoteRunDir}/${CLAIM_DIR}`
  const claimed = await session.exists(claimDir)
  const receipt = await optionalText(
    session,
    `${remoteRunDir}/${kind === 'sbatch' ? REMOTE_JOB_ID_FILE : 'pid'}`
  )
  if (claimed) {
    const savedRunId = await optionalText(session, `${claimDir}/run-id`)
    if (savedRunId?.trim() !== runId) {
      return { kind: 'unknown', reason: '远程启动声明缺失或 run ID 不一致' }
    }
  }
  if (receipt !== undefined) {
    if (kind === 'sbatch' && /^[1-9][0-9]*$/.test(receipt.trim())) {
      return { kind: 'started', jobId: receipt.trim() }
    }
    if (kind === 'detached') {
      const pid = positivePid(receipt)
      if (pid !== undefined) return { kind: 'started', pid }
    }
    return { kind: 'unknown', reason: '远程启动回执格式无效' }
  }
  const exit = await optionalText(session, `${remoteRunDir}/exit_code`)
  if (exit !== undefined) {
    const parsed = Number.parseInt(exit.trim(), 10)
    if (/^[0-9]+$/.test(exit.trim()) && Number.isSafeInteger(parsed)) {
      return { kind: 'started', exitCode: parsed }
    }
    return { kind: 'unknown', reason: '远程退出码格式无效' }
  }
  const rejected = await optionalText(session, `${remoteRunDir}/${REMOTE_LAUNCH_ERROR_FILE}`)
  if (rejected !== undefined) {
    return { kind: 'rejected', reason: rejected.trim() || '服务器拒绝启动' }
  }
  if (claimed) return { kind: 'unknown', reason: '远程已有启动声明，但尚未找到启动回执' }
  if (
    (await session.exists(`${remoteRunDir}/launch.sh`)) ||
    (await session.exists(`${remoteRunDir}/job.sbatch`))
  ) {
    return { kind: 'unknown', reason: '远程目录含旧启动文件，无法证明作业未启动' }
  }
  return { kind: 'unclaimed' }
}

/** Refuse to signal an ID taken from a stale or mismatched local snapshot. */
export async function verifyRemoteCancelTarget(
  session: RemoteSshSession,
  remoteRunDir: string,
  runId: string,
  kind: RemoteLaunchKind,
  identifier: number | string
): Promise<void> {
  const claimDir = `${remoteRunDir}/${CLAIM_DIR}`
  const savedRunId = await optionalText(session, `${claimDir}/run-id`)
  if (savedRunId?.trim() !== runId) {
    throw new Error(`远程运行 ${runId} 的启动声明缺失或不一致，拒绝发送取消信号`)
  }
  const receipt = await optionalText(
    session,
    `${remoteRunDir}/${kind === 'sbatch' ? REMOTE_JOB_ID_FILE : 'pid'}`
  )
  if (receipt?.trim() !== String(identifier)) {
    throw new Error(`远程运行 ${runId} 的进程或作业回执不一致，拒绝发送取消信号`)
  }
}

/** Atomic mkdir is the one-way launch decision for this run ID. Never remove this claim. */
export async function claimRemoteLaunch(
  session: RemoteSshSession,
  remoteRunDir: string,
  runId: string
): Promise<boolean> {
  await session.mkdirp(remoteRunDir)
  const claimDir = `${remoteRunDir}/${CLAIM_DIR}`
  const result = await session.exec(`mkdir ${shellQuote(claimDir)} 2>/dev/null`)
  if (result.code === 0) {
    await session.writeTextFile(`${claimDir}/run-id`, `${runId}\n`)
    return true
  }
  if (await session.exists(claimDir)) return false
  throw new Error(
    `服务器无法建立运行 ${runId} 的启动声明: ${(result.stderr || result.stdout).trim()}`
  )
}

export class RemoteLaunchUnknownError extends Error {
  constructor(
    readonly runId: string,
    readonly remoteRunDir: string,
    reason: string
  ) {
    super(`远程运行 ${runId} 的启动结果未知：${reason}。已保留远程目录，请勿重复提交。`)
    this.name = 'RemoteLaunchUnknownError'
  }
}

export class RemoteLaunchRejectedError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'RemoteLaunchRejectedError'
  }
}
