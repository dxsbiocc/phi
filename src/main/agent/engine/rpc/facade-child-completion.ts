import type { OmpBridge } from '../omp-bridge'
import { AGENT_RUN_HOST_METHODS } from '../../agents/run-host'
import type { RemoteSessionRuntime } from './remote-session-runtime'
import type { RpcChildRunSnapshot } from './subagents/types'
import type { SessionRun } from '../../session/session-runner-registry'
import type { PhiRuntimeRef } from '../../session/runtime-reference'
import { recordChildRunRecovery } from '../../session/child-run-recovery'
import { parseAgentReport, requireDeclaredCompletion } from '../../agents/report'

export function createFacadeChildObservers(input: {
  readonly reference: () => PhiRuntimeRef | undefined
  readonly runtime: () => RemoteSessionRuntime | undefined
  readonly unavailable: () => boolean
  readonly isCurrent: () => boolean
  readonly assertCurrent: () => void
  readonly onChange?: (snapshot: Readonly<RpcChildRunSnapshot>, parent: SessionRun) => void
  readonly originSessionId: string
  readonly hostServices: OmpBridge['hostServices']
}): {
  onChildChange: (snapshot: Readonly<RpcChildRunSnapshot>, parent: SessionRun) => void
  onChildFinished: (
    snapshot: Readonly<RpcChildRunSnapshot>,
    parent: SessionRun,
    task?: string
  ) => Promise<void>
} {
  return {
    onChildChange: (snapshot, parent) => {
      const reference = input.reference()
      if (!reference || input.unavailable() || !input.isCurrent()) return
      input.assertCurrent()
      recordChildRunRecovery({ reference, snapshot }, { assertCurrent: input.assertCurrent })
      input.onChange?.(snapshot, parent)
    },
    onChildFinished: (snapshot, _parent, task) =>
      deliverFacadeChildCompletion({ ...input, snapshot, task })
  }
}

export async function deliverFacadeChildCompletion(input: {
  readonly snapshot: Readonly<RpcChildRunSnapshot>
  readonly runtime: () => RemoteSessionRuntime | undefined
  readonly unavailable: () => boolean
  readonly isCurrent: () => boolean
  readonly task?: string
  readonly originSessionId: string
  readonly hostServices: OmpBridge['hostServices']
}): Promise<void> {
  const current = (): boolean => {
    try {
      return !input.unavailable() && input.isCurrent()
    } catch {
      return false
    }
  }
  if (!current()) return
  const runtime = input.runtime()
  if (!runtime) return
  let report = ''
  let reportError = false
  try {
    report = await runtime.readChildReport(input.snapshot)
  } catch {
    reportError = true
  }
  if (!current() || input.runtime() !== runtime) return
  const { snapshot } = input
  const parsed = parseAgentReport(report)
  const hasMalformedMarker = /<phi_agent_result>/iu.test(report) && !parsed.structured
  const validReport =
    !reportError &&
    !!report.trim() &&
    !hasMalformedMarker &&
    (parsed.status !== 'completed' || !!parsed.text.trim())
  const hostTask = input.task?.trim()
  if (!current() || input.runtime() !== runtime) return
  await input.hostServices.invoke(
    AGENT_RUN_HOST_METHODS.finished,
    {
      originSessionId: input.originSessionId,
      run: {
        id: snapshot.id,
        agent: snapshot.agent,
        state:
          snapshot.status === 'completed'
            ? validReport
              ? 'done'
              : 'error'
            : snapshot.status === 'aborted'
              ? 'cancelled'
              : 'error',
        task: hostTask ?? '',
        ...(hostTask ? { origin: 'host', background: true } : {}),
        startedAt: snapshot.startedAt,
        completedAt: snapshot.completedAt,
        toolCallId: snapshot.parentToolCallId,
        ...(validReport ? { report } : { error: '专家任务未提供完整结果，请查看任务记录。' }),
        ...(hostTask && validReport
          ? {
              reportStatus: requireDeclaredCompletion(parsed).status,
              missingInputs: parsed.missingInputs
            }
          : {})
      }
    },
    { originSessionId: input.originSessionId, agentRunId: snapshot.id }
  )
}
