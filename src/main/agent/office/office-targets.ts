import type { OfficeResolvedSelection } from './office-selection-resolver'

export interface OfficeRunTarget {
  readonly runId: string
  readonly artifactId: string
  readonly sessionId: string
  readonly projectId: string | null
  readonly selection?: OfficeResolvedSelection
}

export type OfficeTargetResolveErrorCode = 'no_target' | 'target_missing' | 'session_mismatch'
export type OfficeTargetErrorCode = OfficeTargetResolveErrorCode | 'target_already_bound'

export class OfficeTargetError extends Error {
  constructor(readonly code: OfficeTargetErrorCode) {
    super(errorMessage(code))
    this.name = 'OfficeTargetError'
  }
}

export class OfficeTargetRegistry {
  private readonly bindings = new Map<string, OfficeRunTarget>()
  private readonly missing = new Map<string, string>()
  private readonly runControllers = new Map<string, AbortController>()

  bindRunTarget(target: OfficeRunTarget): void {
    if (this.bindings.has(target.runId) || this.missing.has(target.runId)) {
      throw new OfficeTargetError('target_already_bound')
    }
    const selection = target.selection
      ? Object.freeze({ ...target.selection, paths: Object.freeze([...target.selection.paths]) })
      : undefined
    this.bindings.set(
      target.runId,
      Object.freeze({ ...target, ...(selection ? { selection } : {}) })
    )
    this.runControllers.set(target.runId, new AbortController())
  }

  signalForRun(runId: string): AbortSignal | undefined {
    return this.runControllers.get(runId)?.signal
  }

  artifactIdForRun(runId: string): string | undefined {
    return this.bindings.get(runId)?.artifactId
  }

  runReferenceCount(artifactId: string): number {
    let count = 0
    for (const target of this.bindings.values()) {
      if (target.artifactId === artifactId) count += 1
    }
    return count
  }

  abortRun(runId: string): boolean {
    const controller = this.runControllers.get(runId)
    if (!controller || controller.signal.aborted) return false
    controller.abort()
    return true
  }

  resolveRunTarget(runId: string, expectedSessionId?: string): OfficeRunTarget {
    const target = this.bindings.get(runId)
    if (!target) return this.resolveMissing(runId, expectedSessionId)
    if (expectedSessionId !== undefined && target.sessionId !== expectedSessionId) {
      throw new OfficeTargetError('session_mismatch')
    }
    return target
  }

  markArtifactReleased(artifactId: string): number {
    let released = 0
    for (const [runId, target] of this.bindings) {
      if (target.artifactId !== artifactId) continue
      this.bindings.delete(runId)
      this.missing.set(runId, target.sessionId)
      this.releaseRunController(runId)
      released += 1
    }
    return released
  }

  clearRunTarget(runId: string): boolean {
    const target = this.bindings.get(runId)
    const hadBinding = this.bindings.delete(runId)
    if (target) this.missing.set(runId, target.sessionId)
    this.releaseRunController(runId)
    return hadBinding
  }

  clearSession(sessionId: string): number {
    let cleared = 0
    for (const [runId, target] of this.bindings) {
      if (target.sessionId !== sessionId) continue
      this.bindings.delete(runId)
      this.releaseRunController(runId)
      cleared += 1
    }
    for (const [runId, missingSessionId] of this.missing) {
      if (missingSessionId !== sessionId) continue
      this.missing.delete(runId)
      this.releaseRunController(runId)
      cleared += 1
    }
    return cleared
  }

  private releaseRunController(runId: string): void {
    this.abortRun(runId)
    this.runControllers.delete(runId)
  }

  private resolveMissing(runId: string, expectedSessionId?: string): never {
    const sessionId = this.missing.get(runId)
    if (!sessionId) throw new OfficeTargetError('no_target')
    if (expectedSessionId !== undefined && sessionId !== expectedSessionId) {
      throw new OfficeTargetError('session_mismatch')
    }
    throw new OfficeTargetError('target_missing')
  }
}

function errorMessage(code: OfficeTargetErrorCode): string {
  if (code === 'session_mismatch') return '关联的 Office 文档不属于当前会话'
  if (code === 'target_missing') return '关联的 Office 文档已不存在或已关闭'
  if (code === 'target_already_bound') return '此任务已经关联 Office 文档'
  return '此任务没有关联 Office 文档'
}
