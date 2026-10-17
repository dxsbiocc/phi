import { createRunId } from '../../src/main/agent/session/session-store'
import { runChildCase } from './case-child'
import type { CaseContext, ToolRoundTrip } from './case-context'
import { runNativeCase } from './case-native'
import { runRecoveryCase } from './case-recovery'
import { bounded, CASE_MS } from './types'
import type { AgentProxy, R8Application } from './application-types'
import type { R8Workspace } from './workspace'

/**
 * Runs the three mandatory cases in order against one Phi session, each bounded to CASE_MS.
 * Every proxy is disposed through the production API even when a case fails; the first
 * failure stays primary and disposal failures are attached to it.
 */
export async function runR8Cases(
  runId: string,
  remote: R8Workspace,
  app: R8Application
): Promise<Record<string, unknown>[]> {
  const results: Record<string, unknown>[] = []
  const active = new Set<AgentProxy>()
  const detach = new Map<AgentProxy, () => void>()
  const toolStarts = new Map<string, { name: string; at: number }>()
  const tools: ToolRoundTrip[] = []

  const attach = async (id: string, resume: boolean): Promise<AgentProxy> => {
    const proxy = (await app.attach(id, resume)).session
    active.add(proxy)
    detach.set(
      proxy,
      proxy.subscribe((raw) => {
        const event = raw as unknown as Record<string, unknown>
        if (typeof event.toolCallId !== 'string' || typeof event.toolName !== 'string') return
        if (event.type === 'tool_execution_start')
          toolStarts.set(event.toolCallId, { name: event.toolName, at: performance.now() })
        else if (event.type === 'tool_execution_end') {
          const start = toolStarts.get(event.toolCallId)
          if (!start) return
          const result = event.result as Record<string, unknown> | undefined
          tools.push({
            id: event.toolCallId,
            name: start.name,
            elapsedMs: performance.now() - start.at,
            isError: event.isError === true || result?.isError === true
          })
          toolStarts.delete(event.toolCallId)
        }
      })
    )
    return proxy
  }
  const dispose = async (proxy: AgentProxy): Promise<void> => {
    try {
      await proxy.dispose()
    } finally {
      detach.get(proxy)?.()
      detach.delete(proxy)
      active.delete(proxy)
    }
  }

  app.approval({
    shouldGate: (request) => ['edit', 'write', 'bash'].includes(request.toolName),
    requestToolApproval: () => 'approved'
  })
  const phi = app.create()
  const context: CaseContext = {
    runId,
    remote,
    app,
    phiSessionId: phi.sessionId,
    markers: {
      original: `R8_SEED_${runId}`,
      edited: `R8_EDITED_${runId}`,
      bash: `R8_BASH_${runId}`
    },
    tools,
    proxy: undefined,
    attach,
    dispose,
    run: (proxy, text) =>
      app.runners.startRun({
        sessionId: phi.sessionId,
        runId: createRunId(),
        execute: () => proxy.prompt(text)
      }),
    complete(entry) {
      results.push(entry)
      console.log(JSON.stringify({ type: 'r8_case', ...entry }))
    }
  }

  let primary: unknown
  try {
    await bounded(runNativeCase(context), CASE_MS, 'native search/read/edit/bash')
    await bounded(runChildCase(context), CASE_MS, 'one native child')
    await bounded(runRecoveryCase(context), CASE_MS, 'transport loss and explicit restore')
  } catch (error) {
    primary = error
  } finally {
    const closed = await Promise.allSettled([...active].map(dispose))
    const failures = closed.flatMap((item) => (item.status === 'rejected' ? [item.reason] : []))
    if (failures.length)
      primary = primary
        ? new AggregateError([primary, ...failures], 'R8 case and disposal failed', {
            cause: primary
          })
        : new AggregateError(failures, 'R8 case disposal failed')
  }
  if (primary) throw primary
  return results
}
