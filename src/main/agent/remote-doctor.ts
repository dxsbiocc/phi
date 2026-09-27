import { spawnSync } from 'node:child_process'
import type {
  RemoteDoctorCheck,
  RemoteDoctorOptions,
  RemoteDoctorReport,
  RemoteDoctorStatus
} from '../../shared/remoteDoctorTypes'
import { DEFAULT_REMOTE_RUNTIME } from '../../shared/wrapperRemoteTypes'
import { getRemoteHostProfile, remoteConnectionConfigForProfile } from './remote-hosts'
import { getPhiAgentDir } from './runtime-paths'
import { remotePreflightRequirements } from './wrappers/composition/remote-config'
import type { ConnectImpl } from './wrappers/executor-remote'
import {
  diagnoseSshConnectionFailure,
  RemoteSshConnectionError,
  sshConnectionDiagnosis
} from './wrappers/remote-ssh-diagnostics'
import {
  connectRemoteSshSession,
  shellQuote,
  type RemoteSshSession
} from './wrappers/remote-ssh-session'

const CHECK_TIMEOUT_MS = 5_000
const CONNECT_TIMEOUT_MS = 15_000

export interface RemoteDoctorDependencies {
  agentDir?: string
  connectImpl?: ConnectImpl
  sftpAvailable?: () => boolean
  checkTimeoutMs?: number
  connectTimeoutMs?: number
  now?: () => Date
  /** Tool checks are repeated after saved setup at launch; Doctor never executes setup lines. */
  deferToolChecksToLaunch?: boolean
}

function systemSftpAvailable(): boolean {
  const result = spawnSync('sftp', ['-h'], { stdio: 'ignore', timeout: 2_000 })
  return !result.error
}

class DoctorTimeoutError extends Error {}

async function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new DoctorTimeoutError()), timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function normalizedOptions(input: unknown): RemoteDoctorOptions {
  const value = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  return {
    ...(value.scope === 'workspace' || value.scope === 'full' ? { scope: value.scope } : {}),
    ...(value.scheduler === 'local' || value.scheduler === 'slurm'
      ? { scheduler: value.scheduler }
      : {}),
    ...(value.controller === 'login' || value.controller === 'sbatch'
      ? { controller: value.controller }
      : {}),
    ...(value.runtime === 'singularity' || value.runtime === 'conda' || value.runtime === 'docker'
      ? { runtime: value.runtime }
      : {}),
    ...(typeof value.nextflowBin === 'string' && value.nextflowBin.trim().length <= 512
      ? { nextflowBin: value.nextflowBin.trim() }
      : {})
  }
}

function validRemotePath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.startsWith('/') &&
    path.length <= 4096 &&
    !/[\r\n\0]/.test(path)
  )
}

function report(
  hostProfileId: string,
  checks: RemoteDoctorCheck[],
  now: () => Date
): RemoteDoctorReport {
  return {
    hostProfileId,
    checkedAt: now().toISOString(),
    ok: checks.every((check) => check.status !== 'error'),
    checks
  }
}

async function commandCheck(
  session: RemoteSshSession,
  timeoutMs: number,
  input: {
    id: string
    command: string
    success: string
    missing: string
    missingStatus: RemoteDoctorStatus
    suggestion: string
  }
): Promise<RemoteDoctorCheck> {
  try {
    const result = await bounded(session.exec(input.command), timeoutMs)
    return result.code === 0
      ? { id: input.id, status: 'ok', message: input.success }
      : {
          id: input.id,
          status: input.missingStatus,
          message: input.missing,
          suggestion: input.suggestion
        }
  } catch (error) {
    return {
      id: input.id,
      status: input.missingStatus,
      message: error instanceof DoctorTimeoutError ? '远程检查超时' : '远程检查未完成',
      suggestion: '检查 SSH 连接和服务器状态后重试。'
    }
  }
}

function availableCommand(candidates: string[]): string {
  const probe = candidates
    .map((binary) => `command -v -- ${shellQuote(binary)} >/dev/null 2>&1`)
    .join(' || ')
  return `bash -lc ${shellQuote(probe)}`
}

/** Read-only server and candidate-directory checks, usable before a project exists. */
export async function remoteDoctor(
  hostProfileId: string,
  remotePath?: string,
  options: RemoteDoctorOptions = {},
  dependencies: RemoteDoctorDependencies = {}
): Promise<RemoteDoctorReport> {
  const checks: RemoteDoctorCheck[] = []
  const now = dependencies.now ?? (() => new Date())
  const agentDir = dependencies.agentDir ?? getPhiAgentDir()
  const profile = getRemoteHostProfile(hostProfileId, agentDir)
  if (!profile) {
    checks.push({
      id: 'ssh',
      status: 'error',
      message: '找不到 SSH 服务器档案',
      suggestion: '先在远程设置中添加服务器，或重新选择一个现有档案。'
    })
    return report(hostProfileId, checks, now)
  }

  const selected = normalizedOptions(options)
  const checkTimeoutMs = dependencies.checkTimeoutMs ?? CHECK_TIMEOUT_MS
  const connectTimeoutMs = dependencies.connectTimeoutMs ?? CONNECT_TIMEOUT_MS
  const connect = dependencies.connectImpl ?? connectRemoteSshSession
  let session: RemoteSshSession
  try {
    session = await bounded(
      connect({
        ...remoteConnectionConfigForProfile(profile),
        readyTimeoutMs: connectTimeoutMs,
        execTimeoutMs: checkTimeoutMs
      }),
      connectTimeoutMs + 1_000
    )
  } catch (error) {
    const diagnosis =
      error instanceof RemoteSshConnectionError
        ? sshConnectionDiagnosis(error.code)
        : error instanceof DoctorTimeoutError
          ? sshConnectionDiagnosis('timeout')
          : diagnoseSshConnectionFailure(error)
    checks.push({
      id: 'ssh',
      status: 'error',
      message: diagnosis.message,
      suggestion: diagnosis.suggestion
    })
    return report(hostProfileId, checks, now)
  }

  checks.push({ id: 'ssh', status: 'ok', message: 'SSH 非交互连接成功' })
  checks.push(
    (dependencies.sftpAvailable ?? systemSftpAvailable)()
      ? { id: 'sftp', status: 'ok', message: '系统 SFTP 程序可用' }
      : {
          id: 'sftp',
          status: 'error',
          message: '系统 SFTP 程序不可用',
          suggestion: '确认系统可运行 sftp；远程 Wrapper 上传需要此程序。'
        }
  )
  try {
    if (remotePath !== undefined) {
      if (!validRemotePath(remotePath)) {
        checks.push({
          id: 'path',
          status: 'error',
          message: '候选目录必须是远端绝对路径',
          suggestion: '填写以 / 开头的服务器目录路径。'
        })
      } else {
        const directory = await commandCheck(session, checkTimeoutMs, {
          id: 'path',
          command: `test -d ${shellQuote(remotePath)}`,
          success: '候选目录存在',
          missing: '候选目录不存在或不是目录',
          missingStatus: 'error',
          suggestion: '检查服务器上的绝对路径。'
        })
        checks.push(directory)
        if (directory.status === 'ok') {
          checks.push(
            await commandCheck(session, checkTimeoutMs, {
              id: 'path_read',
              command: `test -r ${shellQuote(remotePath)} && test -x ${shellQuote(remotePath)}`,
              success: '候选目录可读取和进入',
              missing: '候选目录不可读取或进入',
              missingStatus: 'error',
              suggestion: '检查服务器目录的读取和执行权限。'
            })
          )
          checks.push(
            await commandCheck(session, checkTimeoutMs, {
              id: 'path_write',
              command: `test -w ${shellQuote(remotePath)}`,
              success: '候选目录可写入',
              missing: '候选目录不可写入',
              missingStatus: 'error',
              suggestion: '选择有写入权限的工作目录。'
            })
          )
        }
      }
    }

    const shell = await commandCheck(session, checkTimeoutMs, {
      id: 'shell',
      command: `bash -lc ${shellQuote('printf phi-doctor-ready')}`,
      success: 'Bash 登录 shell 可用',
      missing: 'Bash 登录 shell 不可用',
      missingStatus: 'error',
      suggestion: '确认登录 shell 可启动 Bash；Wrapper 预检使用 Bash。'
    })
    checks.push(shell)
    if (shell.status !== 'ok') return report(hostProfileId, checks, now)
    if (selected.scope === 'workspace') return report(hostProfileId, checks, now)

    const requirements = remotePreflightRequirements(
      {
        scheduler: selected.scheduler ?? 'local',
        controller: selected.controller,
        nextflowBin: selected.nextflowBin
      },
      selected.runtime ?? DEFAULT_REMOTE_RUNTIME
    )
    const deferTools = dependencies.deferToolChecksToLaunch === true
    checks.push(
      await commandCheck(session, checkTimeoutMs, {
        id: 'nextflow',
        command: availableCommand([requirements.nextflow]),
        success: '找到 Nextflow 命令',
        missing: '未找到 Nextflow',
        missingStatus: selected.controller === 'sbatch' || deferTools ? 'warning' : 'error',
        suggestion:
          selected.controller === 'sbatch'
            ? '控制进程由 sbatch 在计算节点启动；请确认计算节点上的启动命令能提供 Nextflow。'
            : '检查 Nextflow 路径；如果需要 module load，请在运行配置中设置启动命令。'
      })
    )
    checks.push(
      await commandCheck(session, checkTimeoutMs, {
        id: 'java',
        command: availableCommand(['java']),
        success: '找到 Java 命令',
        missing: '未找到 Java',
        missingStatus: selected.controller === 'sbatch' || deferTools ? 'warning' : 'error',
        suggestion:
          selected.controller === 'sbatch'
            ? '请确认计算节点上的启动命令能提供 Java。'
            : '安装 Java，或在运行配置中加载提供 Java 的环境模块。'
      })
    )
    for (const [id, binary, label] of [
      ['slurm_submit', 'sbatch', 'Slurm 提交命令'],
      ['slurm_status', 'squeue', 'Slurm 状态命令'],
      ['slurm_detail', 'scontrol', 'Slurm 详情命令'],
      ['slurm_cancel', 'scancel', 'Slurm 取消命令']
    ]) {
      checks.push(
        await commandCheck(session, checkTimeoutMs, {
          id,
          command: availableCommand([binary]),
          success: `找到${label}`,
          missing: `未找到${label}`,
          missingStatus: requirements.requiresSbatch && !deferTools ? 'error' : 'warning',
          suggestion: requirements.requiresSbatch
            ? '当前运行方式需要 Slurm；检查集群环境或在运行配置中加载 Slurm 命令。'
            : '仅在选择 Slurm 运行方式时需要此命令。'
        })
      )
    }
    const runtime = selected.runtime ?? DEFAULT_REMOTE_RUNTIME
    checks.push(
      await commandCheck(session, checkTimeoutMs, {
        id: 'runtime',
        command: availableCommand(requirements.runtimeCandidates),
        success: `登录节点可找到 ${runtime} 运行时`,
        missing: `${runtime} 运行时在登录节点未找到`,
        missingStatus: selected.scheduler === 'slurm' || deferTools ? 'warning' : 'error',
        suggestion:
          selected.scheduler === 'slurm'
            ? '部分集群只在计算节点提供容器运行时；请核对作业节点环境和运行配置。'
            : '当前选择直接在主机运行，须在该主机提供所选运行时或配置加载命令。'
      })
    )
    if (selected.scheduler === 'slurm' && selected.controller !== 'sbatch') {
      checks.push({
        id: 'login_controller',
        status: 'warning',
        message: 'Nextflow 控制进程将在登录节点持续运行',
        suggestion: '若集群禁止登录节点长进程，请将控制方式改为 sbatch。'
      })
    }
    return report(hostProfileId, checks, now)
  } finally {
    await bounded(session.close(), 3_000).catch(() => undefined)
  }
}
