import type {
  RuntimeRecoveryIssue,
  RuntimeRecoveryModelSelection,
  RuntimeRecoveryState,
  RuntimeRecoverySummary,
  RuntimeRecoveryTarget,
  RuntimeSummaryContinuation
} from '../../../shared/runtimeRecoveryTypes'

export interface RuntimeRecoveryScope {
  readonly state: RuntimeRecoveryState
  assertCurrent(): void
  assertIdle(): void
}
export interface RuntimeRecoveryDependencies<
  Scope extends RuntimeRecoveryScope = RuntimeRecoveryScope
> {
  capture(target: RuntimeRecoveryTarget): Promise<Scope> | Scope
  resolveModel(
    selection: RuntimeRecoveryModelSelection,
    scope: Scope
  ): Promise<RuntimeRecoveryModelSelection>
  resume(scope: Scope, replacement?: RuntimeRecoveryModelSelection): Promise<RuntimeRecoveryState>
  summarize(scope: Scope): RuntimeRecoverySummary
  continueFromSummary(
    scope: Scope,
    summary: RuntimeRecoverySummary
  ): Promise<RuntimeSummaryContinuation>
}

export function runtimeRecoveryTarget(value: unknown): RuntimeRecoveryTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('恢复目标无效')
  const target = value as Record<string, unknown>
  if (
    Object.keys(target).some(
      (key) => !['sessionId', 'projectId', 'sessionPath', 'sessionGeneration'].includes(key)
    ) ||
    typeof target.sessionId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(target.sessionId) ||
    typeof target.projectId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(target.projectId) ||
    target.sessionPath !== `phi-session:${target.sessionId}` ||
    !Number.isSafeInteger(target.sessionGeneration) ||
    (target.sessionGeneration as number) < 0
  ) {
    throw new Error('恢复目标无效')
  }
  return {
    sessionId: target.sessionId,
    projectId: target.projectId,
    sessionPath: target.sessionPath as string,
    sessionGeneration: target.sessionGeneration as number
  }
}
export function runtimeRecoveryModel(value: unknown): RuntimeRecoveryModelSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('替代模型无效')
  const model = value as Record<string, unknown>
  if (
    Object.keys(model).some((key) => key !== 'providerId' && key !== 'modelId') ||
    typeof model.providerId !== 'string' ||
    !model.providerId.trim() ||
    model.providerId.length > 256 ||
    typeof model.modelId !== 'string' ||
    !model.modelId.trim() ||
    model.modelId.length > 512 ||
    Array.from(model.providerId + model.modelId).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  )
    throw new Error('替代模型无效')
  return { providerId: model.providerId, modelId: model.modelId }
}

export function runtimeRecoveryMessage(issue: RuntimeRecoveryIssue): string {
  return {
    disconnected: '远程会话尚未连接。恢复只会连接原有历史，不会重发消息或任务。',
    'model-unavailable': '原模型目前不可用，请选择可用模型后显式恢复。',
    'journal-missing': '服务器上的原会话历史已丢失。旧会话会保留，可选择用本地摘要另建会话。',
    'journal-invalid': '原会话历史或定位信息无法验证。旧会话会保留，请核对服务器或选择摘要新会话。',
    'asset-missing': '原会话引用的服务器文件缺失，不能安全恢复原会话。',
    'binding-changed': '原会话的项目或服务器身份已改变，不能连接到其他位置冒充原会话。',
    'not-enabled': '当前未启用远程会话运行，旧历史仍可查看。',
    unknown: '原会话当前无法恢复，旧历史仍会保留。'
  }[issue]
}

/** Main supplies all authority and effects; requests never carry summary bodies or runtime paths. */
export function createRuntimeRecoveryController<Scope extends RuntimeRecoveryScope>(
  dependencies: RuntimeRecoveryDependencies<Scope>
): {
  getState(value: unknown): Promise<RuntimeRecoveryState>
  resume(value: unknown, replacement?: unknown): Promise<RuntimeRecoveryState>
  continueFromSummary(value: unknown, sha256: unknown): Promise<RuntimeSummaryContinuation>
} {
  const pending = new Set<string>()
  const capture = async (value: unknown): Promise<Scope> => {
    const target = runtimeRecoveryTarget(value)
    const scope = await dependencies.capture(target)
    if (
      ['sessionId', 'projectId', 'sessionPath', 'sessionGeneration'].some(
        (field) =>
          scope.state.target[field as keyof RuntimeRecoveryTarget] !==
          target[field as keyof RuntimeRecoveryTarget]
      )
    )
      throw new Error('恢复会话身份不一致')
    scope.assertCurrent()
    return scope
  }
  const act = async <T>(value: unknown, run: (scope: Scope) => Promise<T>): Promise<T> => {
    const target = runtimeRecoveryTarget(value)
    if (pending.has(target.sessionId)) throw new Error('会话恢复操作正在进行')
    pending.add(target.sessionId)
    try {
      const scope = await capture(target)
      scope.assertIdle()
      scope.assertCurrent()
      return await run(scope)
    } finally {
      pending.delete(target.sessionId)
    }
  }
  return {
    getState: async (value) => {
      const scope = await capture(value)
      const summary = dependencies.summarize(scope)
      scope.assertCurrent()
      return pending.has(scope.state.target.sessionId)
        ? {
            ...scope.state,
            phase: 'busy',
            canResume: false,
            message: '正在处理原会话的恢复请求。',
            summary
          }
        : { ...scope.state, summary }
    },
    resume: async (value, supplied) =>
      act(value, async (scope) => {
        if (!scope.state.canResume) throw new Error('当前原会话不能恢复')
        const replacement =
          supplied === undefined
            ? undefined
            : await dependencies.resolveModel(runtimeRecoveryModel(supplied), scope)
        scope.assertIdle()
        scope.assertCurrent()
        return dependencies.resume(scope, replacement)
      }),
    continueFromSummary: async (value, sha256) =>
      act(value, async (scope) => {
        if (scope.state.canContinueFromSummary === false)
          throw new Error('来源项目不可用，不能创建摘要会话')
        if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256))
          throw new Error('恢复摘要确认信息无效')
        const summary = dependencies.summarize(scope)
        if (summary.provenance.sha256 !== sha256)
          throw new Error('来源历史已更新，请重新查看摘要后选择')
        scope.assertIdle()
        scope.assertCurrent()
        const result = await dependencies.continueFromSummary(scope, summary)
        if (result.phiSessionId === scope.state.target.sessionId || result.connected !== false)
          throw new Error('摘要新会话身份无效')
        return result
      })
  }
}
