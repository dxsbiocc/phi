import { shellQuote as q } from '../../src/main/agent/wrappers/remote-ssh-session'
import { findPhiSessionById } from '../../src/main/agent/session/session-store'
import { remoteJournalPath } from '../../src/main/agent/engine/rpc/session-storage/paths'
import assert from 'node:assert/strict'
import type { SessionRunnerRegistry } from '../../src/main/agent/session/session-runner-registry'
import type { AgentProxy, R8Application } from './application-types'
import type { R8Workspace } from './workspace'

export interface ToolRoundTrip {
  readonly id: string
  readonly name: string
  readonly elapsedMs: number
  readonly isError: boolean
}

export interface CaseMarkers {
  readonly original: string
  readonly edited: string
  readonly bash: string
}

/** Shared state of the three sequential cases: one Phi session, one live proxy at a time. */
export interface CaseContext {
  readonly runId: string
  readonly remote: R8Workspace
  readonly app: R8Application
  readonly phiSessionId: string
  readonly markers: CaseMarkers
  readonly tools: ToolRoundTrip[]
  proxy: AgentProxy | undefined
  attach(phiSessionId: string, resume: boolean): Promise<AgentProxy>
  dispose(proxy: AgentProxy): Promise<void>
  run(proxy: AgentProxy, text: string): ReturnType<SessionRunnerRegistry['startRun']>
  complete(entry: Record<string, unknown>): void
}

export interface JournalSnapshot {
  readonly path: string
  readonly ompSessionId: string
  readonly entries: Array<Record<string, unknown>>
}

export function history(proxy: AgentProxy): unknown {
  return proxy.messages.map((raw) => {
    const m = raw as unknown as Record<string, unknown>
    return {
      role: m.role,
      content: m.content,
      provider: m.provider,
      model: m.model,
      stopReason: m.stopReason,
      toolCallId: m.toolCallId
    }
  })
}

export async function journal(remote: R8Workspace, phiSessionId: string): Promise<JournalSnapshot> {
  const ref = findPhiSessionById(phiSessionId)?.runtimeRef
  assert.ok(ref?.kind === 'remote-omp', 'Phi adoption of the remote session is required')
  const path = remoteJournalPath(
    {
      phiSessionId,
      projectId: ref.projectId,
      hostProfileId: ref.hostProfileId,
      bindingHash: ref.bindingHash,
      projectRoot: ref.projectRoot,
      runtimeRoot: ref.runtimeRoot
    },
    { ...ref, phiSessionId }
  )
  const text = await remote.command(`cat -- ${q(path)}`)
  return {
    path,
    ompSessionId: ref.ompSessionId,
    entries: text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  }
}

export function toolResultText(
  request: { messages: Array<Record<string, unknown>> },
  callId: string
): string {
  const messages = request.messages.filter(
    (message) => message.role === 'tool' && message.tool_call_id === callId
  )
  assert.equal(messages.length, 1, `Provider-visible tool result missing: ${callId}`)
  return JSON.stringify(messages[0].content)
}
