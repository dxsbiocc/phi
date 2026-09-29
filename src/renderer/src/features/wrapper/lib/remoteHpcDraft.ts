import type {
  RemoteContainerRuntime,
  RemoteController,
  RemoteHpcSettings
} from '../../../../../shared/wrapperRemoteTypes'

/**
 * Form state for a connection's HPC run settings. Everything is a string so it binds to
 * text fields directly; the conversions below decide what actually gets saved.
 */
export interface HpcDraft {
  /** Where the Nextflow head process runs. */
  controller: RemoteController
  /** Extra sbatch flags for the head job (only used when it is a Slurm job). */
  controllerOptions: string
  scheduler: 'slurm' | 'local'
  runtime: RemoteContainerRuntime
  queue: string
  account: string
  clusterOptions: string
  queueSize: string
  singularityCacheDir: string
  nextflowBin: string
  /** One shell command per line, run before Nextflow (e.g. `module load nextflow`). */
  setupText: string
  /** Nextflow config appended to every run on this connection. */
  nextflowConfig: string
}

export const EMPTY_HPC_DRAFT: HpcDraft = {
  controller: 'login',
  controllerOptions: '',
  scheduler: 'slurm',
  runtime: 'singularity',
  queue: '',
  account: '',
  clusterOptions: '',
  queueSize: '',
  singularityCacheDir: '',
  nextflowBin: '',
  setupText: '',
  nextflowConfig: ''
}

export function hpcDraftFromSettings(hpc: RemoteHpcSettings | undefined): HpcDraft {
  if (!hpc) return EMPTY_HPC_DRAFT
  return {
    controller: hpc.controller ?? 'login',
    controllerOptions: hpc.controllerOptions ?? '',
    scheduler: hpc.scheduler,
    runtime: hpc.runtime ?? 'singularity',
    queue: hpc.queue ?? '',
    account: hpc.account ?? '',
    clusterOptions: hpc.clusterOptions ?? '',
    queueSize: hpc.queueSize ? String(hpc.queueSize) : '',
    singularityCacheDir: hpc.singularityCacheDir ?? '',
    nextflowBin: hpc.nextflowBin ?? '',
    setupText: (hpc.setupCommands ?? []).join('\n'),
    nextflowConfig: hpc.nextflowConfig ?? ''
  }
}

function present(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

export function hpcSettingsFromDraft(draft: HpcDraft): RemoteHpcSettings {
  const slurm = draft.scheduler === 'slurm'
  const queueSize = Number(draft.queueSize)
  const setupCommands = draft.setupText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const headOptions = draft.controller === 'sbatch' ? present(draft.controllerOptions) : undefined
  return {
    scheduler: draft.scheduler,
    runtime: draft.runtime,
    controller: draft.controller,
    ...(headOptions ? { controllerOptions: headOptions } : {}),
    ...(slurm && present(draft.queue) ? { queue: present(draft.queue) } : {}),
    ...(slurm && present(draft.account) ? { account: present(draft.account) } : {}),
    ...(slurm && present(draft.clusterOptions)
      ? { clusterOptions: present(draft.clusterOptions) }
      : {}),
    ...(slurm && Number.isInteger(queueSize) && queueSize > 0 ? { queueSize } : {}),
    ...(present(draft.singularityCacheDir)
      ? { singularityCacheDir: present(draft.singularityCacheDir) }
      : {}),
    ...(present(draft.nextflowBin) ? { nextflowBin: present(draft.nextflowBin) } : {}),
    ...(setupCommands.length > 0 ? { setupCommands } : {}),
    ...(draft.nextflowConfig.trim() ? { nextflowConfig: draft.nextflowConfig.trim() } : {})
  }
}

/** The first problem with the draft, in the words shown to the user, or null. */
export function hpcDraftError(draft: HpcDraft): string | null {
  if (draft.scheduler === 'local' && draft.controller === 'sbatch') {
    return '直接在服务器运行时，Nextflow 主进程不能提交为 Slurm 作业'
  }
  if (draft.queueSize.trim()) {
    const size = Number(draft.queueSize)
    if (!Number.isInteger(size) || size <= 0) return '同时排队的作业数上限必须是正整数'
  }
  if (draft.controller === 'sbatch' && present(draft.controllerOptions)) {
    if (!draft.controllerOptions.trim().startsWith('-')) {
      return '启动 Nextflow 的作业参数必须以 - 开头，例如 --time=7-00:00:00'
    }
  }
  if (present(draft.singularityCacheDir) && !draft.singularityCacheDir.trim().startsWith('/')) {
    return 'Singularity 缓存目录必须是集群上的绝对路径'
  }
  if (present(draft.nextflowBin) && !draft.nextflowBin.trim().startsWith('/')) {
    return 'Nextflow 路径必须是集群上的绝对路径（已在 PATH 中就留空）'
  }
  return null
}
