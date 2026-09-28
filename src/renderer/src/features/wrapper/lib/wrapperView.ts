import type {
  WrapperRun,
  WrapperRunPlan,
  WrapperRetargetRequest,
  WrapperSubmitConfirmation
} from '../../../../../shared/wrapperTypes'
import type { Project } from '../../../lib/projectTypes'
import { declaredExternalOutputRoot } from '../../../../../shared/wrapperResultTypes'

export function wrapperPlanSubmitConfirmation(plan: WrapperRunPlan): WrapperSubmitConfirmation {
  const target = plan.targetSelection
  const externalOutputRoot =
    target?.target === 'remote'
      ? declaredExternalOutputRoot(target.remoteRoot, plan.params?.outdir)
      : undefined
  return {
    expectedRevision: plan.revision,
    target: target?.target ?? (plan.executor === 'local' ? 'local' : 'remote'),
    ...(target ? { projectId: target.projectId } : {}),
    ...(target?.hostProfileId ? { hostProfileId: target.hostProfileId } : {}),
    ...(target?.remoteRoot ? { remoteRoot: target.remoteRoot } : {}),
    ...(externalOutputRoot ? { externalOutputRoot } : {})
  }
}

export function wrapperPlanRetargetRequest(
  plan: WrapperRunPlan,
  target: WrapperRetargetRequest['target']
): WrapperRetargetRequest {
  return {
    planId: plan.planId,
    target,
    expectedRevision: plan.revision,
    ...(plan.targetSelection?.target === 'remote' && target === 'local'
      ? { confirmedLocalFallback: true }
      : {})
  }
}

export function wrapperPlanTargetLines(plan: WrapperRunPlan, run?: WrapperRun): string[] {
  const selected = plan.targetSelection
  const remote = selected?.target === 'remote' || (!selected && plan.executor !== 'local')
  const lines = [
    `执行位置：${remote ? `远程服务器 ${selected?.hostAlias ?? '未绑定'}` : '本机'}`,
    `执行模式：${plan.executor === 'slurm-controller' ? 'Slurm 控制作业' : plan.executor === 'slurm' ? '登录节点控制进程 · Slurm 计算任务' : plan.executor === 'remote-background' ? 'SSH 后台进程' : '本机进程'}`,
    `Profile：${plan.profile}${plan.nextflowProfile && plan.nextflowProfile !== plan.profile ? ` · Nextflow ${plan.nextflowProfile}` : ''}`
  ]
  if (remote) {
    lines.push(`服务器目录：${selected?.remoteRoot ?? '未绑定'}`)
    lines.push(`任务调度：${selected?.scheduler === 'slurm' ? 'Slurm' : '直接在服务器运行'}`)
    lines.push(
      `Nextflow 控制进程：${selected?.controller === 'sbatch' ? 'sbatch 作业' : '登录节点'}`
    )
    lines.push(`容器/环境：${selected?.runtime ?? '未指定'}`)
  }
  if (selected?.reason) lines.push(`目标理由：${selected.reason}`)
  for (const input of plan.inputs) {
    const paths = remote ? input.remotePaths : input.localPaths
    lines.push(`输入 ${input.id}：${paths?.join('，') || input.userValue}`)
  }
  const declaredOutDir = typeof plan.params?.outdir === 'string' ? plan.params.outdir : ''
  const outputLocation = remote
    ? (run?.outDir ??
      (declaredOutDir.startsWith('/')
        ? declaredOutDir
        : `${selected?.remoteRoot ?? '服务器项目目录'}/wrappers/runs/<运行 ID>/${declaredOutDir || 'output'}`))
    : plan.outputDir
  lines.push(`输出位置：${outputLocation}`)
  const externalOutput = remote
    ? declaredExternalOutputRoot(selected?.remoteRoot, declaredOutDir)
    : undefined
  if (externalOutput) lines.push(`外部输出授权范围：${externalOutput}（仅本次运行）`)
  lines.push(
    `资源：${plan.resources.cpus ?? '-'} CPU · ${plan.resources.memory ?? '-'} · ${plan.resources.time ?? '-'}`
  )
  return lines
}

export function wrapperPlanSubmitBlockReason(
  plan: WrapperRunPlan,
  project: Project | undefined,
  projectLoaded: boolean
): string | undefined {
  const selected = plan.targetSelection
  if (!selected) {
    return plan.executor === 'local' ? undefined : '旧远程计划缺少目标快照，请重新创建计划。'
  }
  if (!projectLoaded) return '正在确认项目与服务器状态。'
  if (!project || project.id !== selected.projectId) return '计划所属项目不可用，请重新创建计划。'
  if (project.location.kind !== selected.projectLocation.kind) {
    return '项目位置已变化，请重新创建计划。'
  }
  if (
    project.location.kind === 'local' &&
    selected.projectLocation.kind === 'local' &&
    (project.location.path !== selected.projectLocation.path ||
      project.location.realPath !== selected.projectLocation.realPath)
  ) {
    return '项目目录已变化，请重新创建计划。'
  }
  if (project.location.kind === 'ssh' && selected.projectLocation.kind === 'ssh') {
    if (
      project.location.hostProfileId !== selected.projectLocation.hostProfileId ||
      project.location.canonicalRoot !== selected.projectLocation.canonicalRoot ||
      project.remoteHostAlias !== selected.hostAlias
    ) {
      return '项目服务器或目录已变化，请重新创建计划。'
    }
    const phase = project.remoteConnection?.phase ?? project.remoteReachability ?? 'unchecked'
    if (phase !== 'reachable') {
      return project.remoteConnection?.message ?? '服务器连接尚未就绪，请重连后再提交。'
    }
  }
  if (selected.target === 'remote' && project.location.kind === 'local') {
    const connection = project.remoteConnections?.find((item) => item.id === selected.connectionId)
    if (
      !connection ||
      connection.hostProfileId !== selected.hostProfileId ||
      project.remoteWorkspaceRoot !== selected.remoteRoot
    ) {
      return '远程连接或工作目录已变化，请重新创建计划。'
    }
  }
  return undefined
}

export function trustTierLabel(tier: string): string {
  if (tier === 'bundled') return '内置'
  if (tier === 'custom') return '自定义'
  return tier
}

/**
 * Composition manifest ids follow `<provider>/<tier>/<name...>`, e.g.
 * `nf-core/modules/fastqc` or `nf-core/workflows/rnaseq` — see
 * `resources/wrappers/{modules,subworkflows,workflows}/**\/wrapper/wrapper.yaml`.
 * Not schema-enforced, just the convention every current wrapper.yaml
 * follows, so this degrades to putting the whole id in `name` rather than
 * throwing when an id doesn't fit.
 */
export function parseWrapperCompositionId(id: string): {
  provider: string
  tier: string
  name: string
} {
  const [provider, tier, ...rest] = id.split('/')
  if (!provider || !tier || rest.length === 0) {
    return { provider: provider ?? id, tier: '', name: id }
  }
  return { provider, tier, name: rest.join('/') }
}

export function wrapperTierLabel(tier: string): string {
  if (tier === 'modules') return '模块'
  if (tier === 'subworkflows') return '子流程'
  if (tier === 'workflows') return '工作流'
  return tier
}

/**
 * Distinguishes a wrapper's provenance at a glance: `nf-core` (vendored
 * upstream, pinned biocontainer) vs `local` (Phi's own scripts, no pinned
 * environment yet) vs anything else future providers add. Same MUI Chip
 * `color` vocabulary as `runStateColor` below, so callers just pass it to a
 * `<Chip color={...}>` or look up the matching palette key for custom sx.
 */
export function wrapperProviderColor(provider: string): 'primary' | 'secondary' | 'default' {
  if (provider === 'nf-core') return 'primary'
  if (provider === 'local') return 'secondary'
  return 'default'
}

export function runStateLabel(state: WrapperRun['state']): string {
  const labels: Record<WrapperRun['state'], string> = {
    created: '已创建',
    validating: '校验中',
    provisioning: '准备中',
    queued: '排队中',
    running: '运行中',
    collecting: '收集结果中',
    completed: '已完成',
    failed: '失败',
    cancelling: '取消中',
    cancelled: '已取消',
    lost: '状态未知'
  }
  return labels[state] ?? state
}

export function runStateColor(
  state: WrapperRun['state']
): 'success' | 'error' | 'info' | 'default' {
  if (state === 'completed') return 'success'
  if (state === 'failed' || state === 'lost') return 'error'
  if (state === 'running' || state === 'collecting' || state === 'provisioning') return 'info'
  return 'default'
}

/**
 * "2/6 步 · HISAT2_ALIGN": how far a run has got. The count is processes that have
 * *started* (Nextflow does not report completion), so it is only shown while
 * the outcome is still open or after an unfinished end — a completed run needs no count.
 */
export function runProgressLabel(run: Pick<WrapperRun, 'state' | 'progress'>): string | undefined {
  const progress = run.progress
  if (!progress || progress.started <= 0 || run.state === 'completed') return undefined
  const count = progress.total
    ? `${progress.started}/${progress.total} 步`
    : `已开始 ${progress.started} 步`
  return progress.current ? `${count} · ${progress.current}` : count
}

/** Background (agent-started) runs are owned by the job manager and can be stopped while running. */
export function canCancelBackgroundRun(run: Pick<WrapperRun, 'origin' | 'state'>): boolean {
  return run.origin === 'composition' && run.state === 'running'
}

/** States any executor accepts a cancel for before it's actually running anything — see `runs.ts`'s `cancelWrapperRun` doc comment. */
const PRE_DISPATCH_CANCELLABLE_RUN_STATES: WrapperRun['state'][] = [
  'created',
  'validating',
  'provisioning',
  'queued'
]

/**
 * `slurm-controller` states where the remote job is actually running (or
 * wrapping up) and `cancelWrapperRun` will issue a real `scancel` for it —
 * see that function's doc comment. Local runs can't be cancelled once
 * running (no local kill support exists yet), so this only applies when the
 * run's executor is `slurm-controller`.
 */
const REMOTE_RUNNING_CANCELLABLE_STATES: WrapperRun['state'][] = ['running', 'collecting']

export type WrapperCancelTarget =
  { kind: 'plan'; planId: string } | { kind: 'run'; runId: string } | undefined

/**
 * Picks what a card's Cancel button should act on, and whether it should be
 * enabled at all. Before a plan is submitted, cancelling means
 * `cancelWrapperRunPlan`. Once it's submitted, the plan itself is no longer
 * cancellable (`runs.ts`'s `cancelWrapperRunPlan` refuses a submitted plan
 * outright) — the button needs to switch to `cancelWrapperRun` against the
 * resulting run instead. Bug this replaces: `WrapperPlanCard.tsx` only ever
 * called `cancelWrapperRunPlan` and disabled the button once submitted, so
 * there was no way to cancel a run from the card at all, even though
 * `cancelWrapperRun` already existed and already handles the pre-running
 * states listed above.
 */
export function resolveWrapperCancelTarget(
  plan: Pick<WrapperRunPlan, 'planId' | 'state'>,
  run: Pick<WrapperRun, 'runId' | 'state' | 'executor'> | undefined
): WrapperCancelTarget {
  if (run) {
    const cancellable =
      PRE_DISPATCH_CANCELLABLE_RUN_STATES.includes(run.state) ||
      (run.executor === 'slurm-controller' && REMOTE_RUNNING_CANCELLABLE_STATES.includes(run.state))
    if (cancellable) return { kind: 'run', runId: run.runId }
  }
  if (plan.state === 'valid' || plan.state === 'invalid' || plan.state === 'draft') {
    return { kind: 'plan', planId: plan.planId }
  }
  return undefined
}
