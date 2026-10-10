import type {
  RemoteDoctorCheck,
  RemoteDoctorOptions,
  RemoteDoctorStatus,
  RemoteHostCapabilityProfile
} from '../../../shared/remoteDoctorTypes'
import { DEFAULT_REMOTE_RUNTIME } from '../../../shared/wrapperRemoteTypes'
import { remotePreflightRequirements } from '../wrappers/composition/remote-config'
import { shellQuote } from '../wrappers/remote-ssh-session'
import { doctorCheckFromCapability, selectedRuntimeCapability } from './capability-doctor'

interface CommandCheckInput {
  id: string
  command: string
  success: string
  missing: string
  missingStatus: RemoteDoctorStatus
  suggestion: string
}

interface ToolchainCheckContext {
  profile?: RemoteHostCapabilityProfile
  options: RemoteDoctorOptions
  deferTools: boolean
  run: (input: CommandCheckInput) => Promise<RemoteDoctorCheck>
}

function availableCommand(candidates: string[]): string {
  const probe = candidates
    .map((binary) => `command -v -- ${shellQuote(binary)} >/dev/null 2>&1`)
    .join(' || ')
  return `bash -lc ${shellQuote(probe)}`
}

function status(condition: boolean): RemoteDoctorStatus {
  return condition ? 'warning' : 'error'
}

async function nextflowCheck(
  context: ToolchainCheckContext,
  command: string
): Promise<RemoteDoctorCheck> {
  const { options, profile, deferTools, run } = context
  const input = {
    id: 'nextflow',
    command: availableCommand([command]),
    success: '找到 Nextflow 命令',
    missing: '未找到 Nextflow',
    missingStatus: status(options.controller === 'sbatch' || deferTools),
    suggestion:
      options.controller === 'sbatch'
        ? '控制进程由 sbatch 在计算节点启动；请确认计算节点上的启动命令能提供 Nextflow。'
        : '运行 module load nextflow，或使用管理员提供的 phi-base 环境。'
  }
  const standardCommand = !options.nextflowBin || options.nextflowBin === 'nextflow'
  return profile && standardCommand
    ? doctorCheckFromCapability(profile.toolchain.nextflow, input)
    : run(input)
}

async function javaCheck(context: ToolchainCheckContext): Promise<RemoteDoctorCheck> {
  const { options, profile, deferTools, run } = context
  const input = {
    id: 'java',
    command: availableCommand(['java']),
    success: '找到 Java 命令',
    missing: '未找到 Java',
    missingStatus: status(options.controller === 'sbatch' || deferTools),
    suggestion:
      options.controller === 'sbatch'
        ? '请确认计算节点上的启动命令能提供 Java。'
        : '运行 module load java，或使用管理员提供的 phi-base 环境。'
  }
  return profile ? doctorCheckFromCapability(profile.toolchain.java, input) : run(input)
}

async function slurmChecks(
  context: ToolchainCheckContext,
  required: boolean
): Promise<RemoteDoctorCheck[]> {
  const definitions = [
    ['slurm_submit', 'sbatch', 'Slurm 提交命令'],
    ['slurm_status', 'squeue', 'Slurm 状态命令'],
    ['slurm_detail', 'scontrol', 'Slurm 详情命令'],
    ['slurm_cancel', 'scancel', 'Slurm 取消命令']
  ] as const
  return Promise.all(
    definitions.map(([id, binary, label]) => {
      const input = {
        id,
        command: availableCommand([binary]),
        success: `找到${label}`,
        missing: `未找到${label}`,
        missingStatus: status(!required || context.deferTools),
        suggestion: required
          ? '运行 module load slurm；若站点未提供模块，请联系集群管理员。'
          : '仅在选择 Slurm 运行方式时需要此命令。'
      }
      return context.profile && id === 'slurm_submit'
        ? doctorCheckFromCapability(context.profile.toolchain.sbatch, input)
        : context.run(input)
    })
  )
}

async function runtimeCheck(
  context: ToolchainCheckContext,
  candidates: string[]
): Promise<RemoteDoctorCheck> {
  const runtime = context.options.runtime ?? DEFAULT_REMOTE_RUNTIME
  const input = {
    id: 'runtime',
    command: availableCommand(candidates),
    success: `登录节点可找到 ${runtime} 运行时`,
    missing: `${runtime} 运行时在登录节点未找到`,
    missingStatus: status(context.options.scheduler === 'slurm' || context.deferTools),
    suggestion:
      context.options.scheduler === 'slurm'
        ? '部分集群只在计算节点提供容器运行时；请核对作业节点环境和运行配置。'
        : `运行 module load ${runtime}，或使用管理员提供的 phi-base 环境。`
  }
  const capability = context.profile
    ? selectedRuntimeCapability(context.profile, runtime)
    : undefined
  return capability ? doctorCheckFromCapability(capability, input) : context.run(input)
}

export async function capabilityToolchainChecks(
  context: ToolchainCheckContext
): Promise<RemoteDoctorCheck[]> {
  const requirements = remotePreflightRequirements(
    {
      scheduler: context.options.scheduler ?? 'local',
      controller: context.options.controller,
      nextflowBin: context.options.nextflowBin,
      containerRuntimeBin: context.options.containerRuntimeBin
    },
    context.options.runtime ?? DEFAULT_REMOTE_RUNTIME
  )
  const checks = [
    await nextflowCheck(context, requirements.nextflow),
    await javaCheck(context),
    ...(await slurmChecks(context, requirements.requiresSbatch)),
    await runtimeCheck(context, requirements.runtimeCandidates)
  ]
  if (context.options.scheduler === 'slurm' && context.options.controller !== 'sbatch') {
    checks.push({
      id: 'login_controller',
      status: 'warning',
      message: 'Nextflow 控制进程将在登录节点持续运行',
      suggestion: '若集群禁止登录节点长进程，请将控制方式改为 sbatch。'
    })
  }
  return checks
}
