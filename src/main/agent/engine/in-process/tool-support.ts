import { randomUUID } from 'node:crypto'
import { type CreateAgentSessionResult, type ExtensionFactory } from '@oh-my-pi/pi-coding-agent'
import { PhiTool } from '../types'
import { planModeToolDecision } from '../../plan/plan-tool-policy'
import { BrowserTextVault } from '../../browser/browser-text-vault'
import { buildScopedPhiToolMap } from '../../agents/tool-resolution'
import { ScriptToolDescriptor } from '../../content/skill-tool-types'
import { createHostJobClient } from '../../wrappers/composition/job-host-client'
import { buildWrapperCompositionTools } from '../../wrappers/composition/tools'
import { UnknownRecord, isRecord, stringValue } from './common'
import { requestHost, sendEvent } from './ipc'
import { serializeModel } from './runtime-context'
import { pendingToolApprovals } from './state'

export function requestToolApproval(
  sessionId: string,
  event: UnknownRecord,
  agentRunId?: string,
  browserTextVault?: BrowserTextVault
): Promise<unknown> {
  const requestId = randomUUID()
  sendEvent(
    'toolApproval',
    {
      requestId,
      toolCallId: stringValue(event.toolCallId, requestId),
      toolName: stringValue(event.toolName),
      input:
        browserTextVault && stringValue(event.toolName) === 'browser'
          ? browserTextVault.approvalInput(stringValue(event.toolCallId), event.input)
          : isRecord(event.input)
            ? event.input
            : {},
      ...(agentRunId ? { agentRunId } : {})
    },
    { sessionId }
  )
  return new Promise<unknown>((resolve) => {
    pendingToolApprovals.set(requestId, resolve)
  })
}

export function createBridgeToolApprovalExtension(
  sessionId: string,
  agentRunId?: string,
  browserTextVault?: BrowserTextVault
): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', async (event) => {
      const browserTypeText =
        event.toolName === 'browser' && isRecord(event.input) && event.input.action === 'typeText'
      const result = await requestToolApproval(
        sessionId,
        event as unknown as UnknownRecord,
        agentRunId,
        browserTextVault
      )
      if (browserTypeText && browserTextVault) {
        const input = browserTextVault.approvalInput(event.toolCallId, event.input)
        if (isRecord(result) && result.block === true) {
          browserTextVault.markDenied(event.toolCallId)
          return result
        }
        return { input }
      }
      return result === null ? undefined : result
    })
  }
}

export function createPlanReviewToolGuardExtension(
  isPlanModeActive: () => boolean
): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', async (event) => {
      const decision = planModeToolDecision(isPlanModeActive(), event.toolName, event.input)
      return decision.allowed ? undefined : { block: true, reason: decision.reason }
    })
  }
}

export function serializeSessionState(result: CreateAgentSessionResult): unknown {
  const session = result.session
  return {
    sessionFile: session.sessionFile,
    messages: session.messages,
    model: session.model ? serializeModel(session.model) : undefined,
    thinkingLevel: session.thinkingLevel,
    cwd: session.sessionManager.getCwd()
  }
}

export function isScriptToolDescriptor(value: unknown): value is ScriptToolDescriptor {
  if (!isRecord(value)) return false
  if (typeof value.name !== 'string' || typeof value.description !== 'string') return false
  if (!isRecord(value.parameters)) return false
  if (!Array.isArray(value.attachTo) || value.attachTo.some((item) => typeof item !== 'string')) {
    return false
  }
  if (typeof value.skill !== 'string') return false
  return value.approval === 'read' || value.approval === 'write'
}

export async function loadSkillScriptTools(
  cwd: string,
  remote?: { runtimeSessionId: string; sessionId: string; projectId: string }
): Promise<ScriptToolDescriptor[] | undefined> {
  try {
    const result = await requestHost('skills.scriptTools', {
      cwd,
      ...(remote
        ? {
            runtimeSessionId: remote.runtimeSessionId,
            remoteSessionId: remote.sessionId,
            projectId: remote.projectId
          }
        : {})
    })
    if (!isRecord(result) || !Array.isArray(result.tools)) {
      throw new Error('skills.scriptTools returned an unexpected result')
    }
    const tools: ScriptToolDescriptor[] = []
    for (const entry of result.tools) {
      if (!isScriptToolDescriptor(entry)) {
        throw new Error('skills.scriptTools returned an invalid tool')
      }
      tools.push(entry)
    }
    if (Array.isArray(result.problems)) {
      for (const problem of result.problems) {
        if (typeof problem === 'string' && problem.length > 0) {
          process.stderr.write(`Phi skill tool: ${problem}\n`)
        }
      }
    }
    return tools
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`Phi skill tools unavailable: ${message}\n`)
    return undefined
  }
}

/**
 * The Phi tool functions an agent definition may list in `tools:`. Built fresh
 * per agent session so each one binds to that session. Add a provider here to
 * make more Phi tools available to agents; the delegating (main) agent never
 * receives these directly.
 */
export function phiToolFunctions(
  originSessionId: string,
  agentDir: string,
  cwd: string,
  agentName: string,
  skillRun?: PhiTool
): Map<string, PhiTool> {
  let wrapperTools: PhiTool[] = []
  if (agentName === 'Wrapper') {
    // Wrapper runs are background jobs owned by the main process; these tools only talk to it.
    // Each run is stamped with the session that started it, so its end can be reported there.
    const jobs = createHostJobClient(requestHost, { originSessionId })
    wrapperTools = [...buildWrapperCompositionTools(jobs, { agentDir, projectDir: cwd })]
  }
  const tools = buildScopedPhiToolMap(agentName, {
    wrapper: wrapperTools
  })
  if (skillRun) tools.set(skillRun.name, skillRun)
  return tools
}
