import type { Project } from '../agent/projects'
import type { PromptTargetInput } from '../agent/session/prompt-target-control'
import type { SessionLifecycle, SessionSnapshot } from '../agent/session/session-lifecycle'
import type { PromptImageInput } from '../../shared/promptImageTypes'
import type { SessionKeyLinking } from './session-key-linking'
import type { SessionResolution } from './session-resolution'

export interface SubmitPromptInput {
  sessionKey: string
  snapshot: SessionSnapshot & { permissionMode: Project['permissionMode'] }
  text: string
  images?: PromptImageInput[]
  promptTarget: PromptTargetInput | null
  /** A prompt Phi sends on its own (e.g. a background run ended), not the user's words. */
  automatic?: boolean
  planMode?: boolean
}

export interface ResolvedPromptRunTarget<TResult> {
  input: SubmitPromptInput
  normalizedText: string
  promptTarget: PromptTargetInput | null
  runSessionKey: string
  runLifecycle: SessionLifecycle<TResult>
  runSessionGeneration: number
  runSnapshot: SessionSnapshot & { permissionMode: Project['permissionMode'] }
  automaticModelSelection: boolean
  project: Project | undefined
}

export interface AdmittedPromptRun<TResult> extends ResolvedPromptRunTarget<TResult> {
  phiSessionId: string
  stableSessionPath: string
  runId: string
}

export interface PromptRunAdmissionDeps<TResult> {
  keys: {
    canonicalize(sessionKey: string): string
  }
  lifecycles: {
    forKey(sessionKey: string): SessionLifecycle<TResult>
  }
  resolution: Pick<SessionResolution, 'projectForSession' | 'resolveSessionModelSelection'>
  linking: Pick<SessionKeyLinking, 'ensurePhiSessionId'>
  runs: {
    hasActiveRun(sessionKey: string): boolean
    runtimeRecoveryOperations: {
      has(phiSessionId: string): boolean
    }
    manualCompactionIds: {
      has(phiSessionId: string): boolean
    }
  }
  paths: {
    phiOnlySessionPath(phiSessionId: string): string
    isRemoteAnchorPath(cwd: string): boolean
  }
  createRunId(): string
}

function resolvePromptRunTarget<TResult>(
  deps: PromptRunAdmissionDeps<TResult>,
  input: SubmitPromptInput
): ResolvedPromptRunTarget<TResult> {
  const normalizedText = input.text
  const promptTarget = input.promptTarget
  const runSessionKey = deps.keys.canonicalize(input.sessionKey)
  const runLifecycle = deps.lifecycles.forKey(runSessionKey)
  const runSessionGeneration = runLifecycle.currentGeneration
  const runSnapshot = input.snapshot
  const automaticModelSelection =
    deps.resolution.resolveSessionModelSelection(runSessionKey, runSnapshot) === null
  const project = deps.resolution.projectForSession(runSessionKey, runSnapshot)
  if (
    input.planMode &&
    (project?.location.kind === 'ssh' || deps.paths.isRemoteAnchorPath(runSnapshot.cwd))
  ) {
    throw new Error('远程项目暂不支持计划评审')
  }
  return {
    input,
    normalizedText,
    promptTarget,
    runSessionKey,
    runLifecycle,
    runSessionGeneration,
    runSnapshot,
    automaticModelSelection,
    project
  }
}

function admitPromptRun<TResult>(
  deps: PromptRunAdmissionDeps<TResult>,
  target: ResolvedPromptRunTarget<TResult>
): AdmittedPromptRun<TResult> {
  const phiSessionId = deps.linking.ensurePhiSessionId(
    target.runSessionKey,
    target.runSnapshot,
    target.normalizedText || (target.input.images?.length ? '图片' : undefined)
  )
  if (deps.runs.runtimeRecoveryOperations.has(phiSessionId))
    throw new Error('会话正在恢复，请等待恢复操作结束')
  if (deps.runs.manualCompactionIds.has(phiSessionId)) {
    throw new Error('上下文压缩正在进行，请稍后发送消息')
  }
  const stableSessionPath = deps.paths.phiOnlySessionPath(phiSessionId)
  const runId = deps.createRunId()
  if (deps.runs.hasActiveRun(target.runSessionKey)) {
    throw new Error('会话正在运行')
  }
  return { ...target, phiSessionId, stableSessionPath, runId }
}

export interface PromptRunAdmission<TResult> {
  resolveTarget(input: SubmitPromptInput): ResolvedPromptRunTarget<TResult>
  admit(target: ResolvedPromptRunTarget<TResult>): AdmittedPromptRun<TResult>
}

export function createPromptRunAdmission<TResult>(
  deps: PromptRunAdmissionDeps<TResult>
): PromptRunAdmission<TResult> {
  return {
    resolveTarget: (input) => resolvePromptRunTarget(deps, input),
    admit: (target) => admitPromptRun(deps, target)
  }
}
