import type {
  WrapperRun,
  WrapperRunPlan,
  WrapperRetargetRequest,
  WrapperSubmitConfirmation
} from '../../../../../shared/wrapperTypes'
import type { Project } from '../../../lib/projectTypes'
import { declaredExternalOutputRoot } from '../../../../../shared/wrapperResultTypes'
import { resourceCategoryLabel, resourceUi } from '../../../lib/resourceUi'
import { wrapperCopy } from './wrapperCopy'

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
    wrapperCopy.targetLocation(
      remote
        ? wrapperCopy.remoteServer(selected?.hostAlias ?? wrapperCopy.unbound)
        : wrapperCopy.localDevice
    ),
    wrapperCopy.executionMode(wrapperCopy.executionModes[plan.executor]),
    wrapperCopy.profile(
      `${plan.profile}${plan.nextflowProfile && plan.nextflowProfile !== plan.profile ? ` · Nextflow ${plan.nextflowProfile}` : ''}`
    )
  ]
  if (remote) {
    lines.push(wrapperCopy.serverDirectory(selected?.remoteRoot ?? wrapperCopy.unbound))
    lines.push(
      wrapperCopy.scheduler(selected?.scheduler === 'slurm' ? 'Slurm' : wrapperCopy.directServer)
    )
    lines.push(
      wrapperCopy.nextflowController(
        selected?.controller === 'sbatch' ? wrapperCopy.sbatchJob : wrapperCopy.loginNode
      )
    )
    lines.push(wrapperCopy.containerEnvironment(selected?.runtime ?? wrapperCopy.unspecified))
  }
  if (selected?.reason) lines.push(wrapperCopy.targetReason(selected.reason))
  for (const input of plan.inputs) {
    const paths = remote ? input.remotePaths : input.localPaths
    lines.push(wrapperCopy.inputPaths(input.id, paths?.join(', ') || input.userValue))
  }
  const declaredOutDir = typeof plan.params?.outdir === 'string' ? plan.params.outdir : ''
  const outputLocation = remote
    ? (run?.outDir ??
      (declaredOutDir.startsWith('/')
        ? declaredOutDir
        : `${selected?.remoteRoot ?? wrapperCopy.serverProjectDirectory}/wrappers/runs/<run ID>/${declaredOutDir || 'output'}`))
    : plan.outputDir
  lines.push(wrapperCopy.outputLocation(outputLocation))
  const externalOutput = remote
    ? declaredExternalOutputRoot(selected?.remoteRoot, declaredOutDir)
    : undefined
  if (externalOutput) lines.push(wrapperCopy.externalOutput(externalOutput))
  lines.push(wrapperCopy.resources(plan.resources.cpus, plan.resources.memory, plan.resources.time))
  return lines
}

export function wrapperPlanSubmitBlockReason(
  plan: WrapperRunPlan,
  project: Project | undefined,
  projectLoaded: boolean
): string | undefined {
  const selected = plan.targetSelection
  if (!selected) {
    return plan.executor === 'local' ? undefined : wrapperCopy.legacyRemotePlan
  }
  if (!projectLoaded) return wrapperCopy.checkingProject
  if (!project || project.id !== selected.projectId) return wrapperCopy.projectUnavailable
  if (project.location.kind !== selected.projectLocation.kind) {
    return wrapperCopy.projectLocationChanged
  }
  if (
    project.location.kind === 'local' &&
    selected.projectLocation.kind === 'local' &&
    (project.location.path !== selected.projectLocation.path ||
      project.location.realPath !== selected.projectLocation.realPath)
  ) {
    return wrapperCopy.projectDirectoryChanged
  }
  if (project.location.kind === 'ssh' && selected.projectLocation.kind === 'ssh') {
    if (
      project.location.hostProfileId !== selected.projectLocation.hostProfileId ||
      project.location.canonicalRoot !== selected.projectLocation.canonicalRoot ||
      project.remoteHostAlias !== selected.hostAlias
    ) {
      return wrapperCopy.projectServerChanged
    }
    const phase = project.remoteConnection?.phase ?? project.remoteReachability ?? 'unchecked'
    if (phase !== 'reachable') {
      return project.remoteConnection?.message ?? wrapperCopy.serverNotReady
    }
  }
  if (selected.target === 'remote' && project.location.kind === 'local') {
    const connection = project.remoteConnections?.find((item) => item.id === selected.connectionId)
    if (
      !connection ||
      connection.hostProfileId !== selected.hostProfileId ||
      project.remoteWorkspaceRoot !== selected.remoteRoot
    ) {
      return wrapperCopy.remoteTargetChanged
    }
  }
  return undefined
}

export function trustTierLabel(tier: string): string {
  if (tier === 'bundled') return resourceUi.builtIn
  if (tier === 'custom') return wrapperCopy.custom
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

/** Preserve established category/filter keys; translate only their displayed labels. */
export function wrapperTierCategory(tier: string): string {
  if (tier === 'modules') return '模块'
  if (tier === 'subworkflows') return '子流程'
  if (tier === 'workflows') return '工作流'
  return tier
}

export function wrapperTierLabel(tier: string): string {
  return resourceCategoryLabel(wrapperTierCategory(tier))
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
  const labels: Record<WrapperRun['state'], string> = wrapperCopy.runStates
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
 * "2/6 steps · HISAT2_ALIGN": how far a run has got. The count is processes that have
 * *started* (Nextflow does not report completion), so it is only shown while
 * the outcome is still open or after an unfinished end — a completed run needs no count.
 */
export function runProgressLabel(run: Pick<WrapperRun, 'state' | 'progress'>): string | undefined {
  const progress = run.progress
  if (!progress || progress.started <= 0 || run.state === 'completed') return undefined
  const count = wrapperCopy.progress(progress.started, progress.total)
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
