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
    success: 'Nextflow command found',
    missing: 'Nextflow not found',
    missingStatus: status(options.controller === 'sbatch' || deferTools),
    suggestion:
      options.controller === 'sbatch'
        ? 'The controller starts through sbatch on a compute node. Ensure the compute node startup commands provide Nextflow.'
        : 'Run module load nextflow, or use the phi-base environment provided by the administrator.'
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
    success: 'Java command found',
    missing: 'Java not found',
    missingStatus: status(options.controller === 'sbatch' || deferTools),
    suggestion:
      options.controller === 'sbatch'
        ? 'Ensure the compute node startup commands provide Java.'
        : 'Run module load java, or use the phi-base environment provided by the administrator.'
  }
  return profile ? doctorCheckFromCapability(profile.toolchain.java, input) : run(input)
}

async function slurmChecks(
  context: ToolchainCheckContext,
  required: boolean
): Promise<RemoteDoctorCheck[]> {
  const definitions = [
    ['slurm_submit', 'sbatch', 'Slurm submission command'],
    ['slurm_status', 'squeue', 'Slurm status command'],
    ['slurm_detail', 'scontrol', 'Slurm detail command'],
    ['slurm_cancel', 'scancel', 'Slurm cancellation command']
  ] as const
  return Promise.all(
    definitions.map(([id, binary, label]) => {
      const input = {
        id,
        command: availableCommand([binary]),
        success: `${label} found`,
        missing: `${label} not found`,
        missingStatus: status(!required || context.deferTools),
        suggestion: required
          ? 'Run module load slurm. If the site has no module, contact the cluster administrator.'
          : 'This command is only required when using Slurm.'
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
    success: `${runtime} runtime found on the login node`,
    missing: `${runtime} runtime not found on the login node`,
    missingStatus: status(context.options.scheduler === 'slurm' || context.deferTools),
    suggestion:
      context.options.scheduler === 'slurm'
        ? 'Some clusters provide container runtimes only on compute nodes. Check the job node environment and runtime configuration.'
        : `Run module load ${runtime}, or use the phi-base environment provided by the administrator.`
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
      message: 'The Nextflow controller will keep running on the login node',
      suggestion:
        'If the cluster prohibits long-running processes on login nodes, change the controller mode to sbatch.'
    })
  }
  return checks
}
