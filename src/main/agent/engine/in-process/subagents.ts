import { randomUUID } from 'node:crypto'
import {
  SessionManager,
  Settings,
  type CreateAgentSessionResult,
  type CustomTool,
  type ExtensionFactory
} from '@oh-my-pi/pi-coding-agent'
import { toOmpCustomTool } from '../tool-adapter'
import { PhiTool } from '../types'
import { type RemoteMcpGuardState } from '../../mcp/remote-mcp-policy'
import { buildRemoteWorkspaceReadTool } from '../../remote-workspace-read-tool'
import { RemoteWorkspaceReadResult } from '../../remote-workspace-read'
import { type PhiAgentDefinition } from '../../agents/definition'
import { selectAgentModel } from '../../agents/model-selection'
import { controlAgentRun } from '../../agents/run-control'
import { type AgentSessionLike } from '../../agents/runner'
import { resolveAgentTools } from '../../agents/tool-resolution'
import { createEnvironmentBindingExtension } from '../../agents/environment-binding'
import { createRemoteUrlGuardExtension } from '../../agents/remote-url-guard'
import { installSpecialistToolCallExtensions } from '../../agents/specialist-tool-call-extensions'
import {
  resolveRemoteAgentTools,
  shouldAttachRemoteParentTool
} from '../../agents/remote-agent-tools'
import {
  createRemoteProjectToolGuardExtension,
  remoteAgentSupportedToolNames,
  remoteWorkspaceToolsVerified
} from '../../agents/remote-project-tool-guard'
import { AGENT_REPORT_PROTOCOL } from '../../agents/report'
import { buildEnvRequestTool } from '../../content/env-request-tool'
import { buildScriptTools, buildSkillRunTool } from '../../content/skill-tools'
import { ScriptToolDescriptor } from '../../content/skill-tool-types'
import { selectDeclaredSpecialistSkills } from '../../enablement'
import { RuntimeContext, isRecord, stringValue } from './common'
import { readLoadedSkillResource, requestHost } from './ipc'
import { resourceOptions } from './resources'
import { modelBySelector, runtimeThinkingLevel } from './runtime-context'
import {
  createAgentSession,
  DefaultResourceLoader,
  initializeAgentExtensions,
  SettingsManager
} from './session-factory'
import { sessions } from './state'
import {
  createBridgeToolApprovalExtension,
  createPlanReviewToolGuardExtension,
  phiToolFunctions
} from './tool-support'

/**
 * Builds an in-memory session for one scanned Phi agent. The definition drives
 * everything: its Markdown body is the system prompt, `tools` is the (restricted)
 * toolbox, `skills` the only skills exposed. The session gets its own resource
 * loader (the SDK forbids sharing loaded extension instances across sessions)
 * whose approval extension is bound to the *parent's* sessionId, so its shell
 * and file writes are approved in the chat the user is looking at. A declared
 * `model` is tried in order with the main session's selector lookup; otherwise
 * the parent's model is reused. `thinkingLevel` overrides the parent's level.
 */

export async function bindSpecialistEnvironment(
  definition: PhiAgentDefinition,
  deps: {
    sessionId: string
    cwd: string
    remoteRoot?: string
    remoteProject?: { sessionId: string; projectId: string }
  }
): Promise<{ ref: string; variables: Record<string, string>; pluginId?: string } | undefined> {
  const ref = definition.environment
  if (!ref) return undefined
  const result = await requestHost('environments.bindSession', {
    runtimeSessionId: deps.sessionId,
    ref,
    agent: definition.name,
    cwd: deps.cwd,
    ...(deps.remoteProject
      ? {
          remoteSessionId: deps.remoteProject.sessionId,
          projectId: deps.remoteProject.projectId
        }
      : {}),
    ...(definition.pluginId ? { pluginId: definition.pluginId } : {})
  })
  if (!isRecord(result)) throw new Error('environments.bindSession returned an unexpected result')
  if (isRecord(result.notReady)) {
    const message = result.notReady.message
    if (typeof message !== 'string' || message.length === 0) {
      throw new Error('environments.bindSession returned an unexpected result')
    }
    throw new Error(message)
  }
  const boundRef = result.ref
  const variables = stringRecord(result.variables)
  if (typeof boundRef !== 'string' || boundRef.length === 0 || !variables) {
    throw new Error('environments.bindSession returned an unexpected result')
  }
  return {
    ref: boundRef,
    variables,
    ...(definition.pluginId ? { pluginId: definition.pluginId } : {})
  }
}

export function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const record: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') return undefined
    record[key] = item
  }
  return record
}

export function specialistToolCallFactories(
  deps: {
    sessionId: string
    enableToolApproval: boolean
    agentRunId?: string
    remoteRoot?: string
    skillTools?: ScriptToolDescriptor[]
    remoteMcpToolState?: () => RemoteMcpGuardState | undefined
    parent: () => CreateAgentSessionResult | undefined
  },
  binding?: { ref: string; variables: Record<string, string>; pluginId?: string }
): ExtensionFactory[] {
  // Order matters: omp gives every handler the original input and keeps the last
  // non-empty result, and a block returns at once. Guards and approval run first,
  // so the approval card shows the command the model wrote; the binding's rewrite
  // is last, so it is the input that executes.
  return [
    ...(deps.remoteRoot
      ? [
          createRemoteProjectToolGuardExtension({
            dynamicSkillToolNames: () => new Set((deps.skillTools ?? []).map((tool) => tool.name)),
            remoteMcpToolState: deps.remoteMcpToolState
          })
        ]
      : []),
    createRemoteUrlGuardExtension(),
    createPlanReviewToolGuardExtension(
      () => deps.parent()?.session.getPlanModeState()?.enabled === true
    ),
    ...(deps.enableToolApproval
      ? [createBridgeToolApprovalExtension(deps.sessionId, deps.agentRunId)]
      : []),
    ...(binding ? [createEnvironmentBindingExtension(binding)] : [])
  ]
}

export async function createPhiAgentSession(
  definition: PhiAgentDefinition,
  deps: {
    sessionId: string
    cwd: string
    agentDir: string
    ctx: RuntimeContext
    resourceOptions: unknown
    enableToolApproval: boolean
    agentRunId?: string
    remoteRoot?: string
    remoteProject?: { sessionId: string; projectId: string }
    remoteContextFiles?: Array<{ path: string; content: string }>
    remoteTools?: () => PhiTool[]
    remoteMcpTools?: () => CustomTool[]
    remoteMcpToolState?: () => RemoteMcpGuardState | undefined
    remoteRead?: (path: string) => Promise<RemoteWorkspaceReadResult>
    skillTools?: ScriptToolDescriptor[]
    parent: () => CreateAgentSessionResult | undefined
  }
): Promise<AgentSessionLike> {
  const { sessionId, cwd, agentDir, ctx } = deps
  const remoteResolution = deps.remoteRoot
    ? resolveRemoteAgentTools(definition, remoteAgentSupportedToolNames())
    : undefined
  if (remoteResolution && !remoteResolution.available) {
    throw new Error(remoteResolution.unavailableReason)
  }
  const runtimeDefinition = remoteResolution?.agent ?? definition
  const sessionCwd = deps.remoteRoot ? agentDir : cwd
  const binding = await bindSpecialistEnvironment(runtimeDefinition, deps)
  const holder = binding
    ? {
        ref: binding.ref,
        variables: { ...binding.variables },
        ...(binding.pluginId ? { pluginId: binding.pluginId } : {})
      }
    : undefined
  const toolCallFactories = specialistToolCallFactories(deps, holder)
  const skillHost = holder
    ? {
        runtimeSessionId: sessionId,
        environmentBinding: holder,
        ...(holder.pluginId ? { pluginId: holder.pluginId } : {})
      }
    : sessionId
  const remoteSkillHost = deps.remoteProject
    ? {
        ...(typeof skillHost === 'string' ? { runtimeSessionId: skillHost } : skillHost),
        remoteProject: deps.remoteProject
      }
    : skillHost
  const settings = await Settings.init({ cwd: sessionCwd, agentDir })
  const loader =
    isRecord(deps.resourceOptions) || deps.remoteRoot
      ? new DefaultResourceLoader({
          ...resourceOptions({
            ...(isRecord(deps.resourceOptions) ? deps.resourceOptions : {}),
            cwd: sessionCwd,
            agentDir,
            ...(deps.remoteRoot
              ? {
                  noExtensions: true,
                  noPromptTemplates: true,
                  noThemes: true,
                  noContextFiles: true,
                  appendSystemPrompt: []
                }
              : {})
          }),
          settingsManager: SettingsManager.create(sessionCwd, agentDir),
          extensionFactories: toolCallFactories
        })
      : undefined
  if (loader) await loader.reload()
  const skills = loader
    ? selectDeclaredSpecialistSkills(loader.getSkills().skills, runtimeDefinition.skills)
    : undefined

  const availableTools = phiToolFunctions(
    sessionId,
    agentDir,
    sessionCwd,
    runtimeDefinition.name,
    deps.skillTools
      ? buildSkillRunTool(requestHost, {
          ...(typeof remoteSkillHost === 'string'
            ? { runtimeSessionId: remoteSkillHost }
            : remoteSkillHost),
          allowedSkills: runtimeDefinition.skills
        })
      : undefined
  )
  for (const tool of deps.remoteTools?.() ?? []) {
    if (!shouldAttachRemoteParentTool(runtimeDefinition, tool.name, availableTools.has(tool.name)))
      continue
    if (tool.name !== 'read' || !deps.remoteRead) availableTools.set(tool.name, tool)
  }
  const remoteMcpTools = deps.remoteMcpTools?.() ?? []
  const remoteMcpToolsByName = new Map(remoteMcpTools.map((tool) => [tool.name, tool]))
  // MCP tools were inserted here before T1. Remove same-named earlier Phi tools so MCP keeps
  // winning those collisions; the Phi tools registered below may then override MCP as before.
  for (const tool of remoteMcpTools) availableTools.delete(tool.name)
  if (deps.remoteRead) {
    availableTools.set(
      'read',
      buildRemoteWorkspaceReadTool(deps.remoteRead, {
        readResource: (path) => readLoadedSkillResource(path, skills ?? [], deps.remoteProject)
      })
    )
  }
  const attachedScriptTools = buildScriptTools(
    (deps.skillTools ?? []).filter(
      (tool) =>
        runtimeDefinition.skills.includes(tool.skill) &&
        tool.attachTo.includes(runtimeDefinition.name)
    ),
    requestHost,
    remoteSkillHost
  )
  for (const tool of attachedScriptTools) availableTools.set(tool.name, tool)
  if (holder) {
    const envRequest = buildEnvRequestTool(requestHost, {
      runtimeSessionId: sessionId,
      binding: holder,
      agent: runtimeDefinition.name,
      ...(deps.remoteProject ? { remoteProject: deps.remoteProject } : {})
    })
    availableTools.set(envRequest.name, envRequest)
  }
  const declaredTools = [...runtimeDefinition.tools]
  for (const tool of attachedScriptTools) {
    if (!declaredTools.includes(tool.name)) declaredTools.push(tool.name)
  }
  for (const tool of remoteMcpTools) {
    if (!declaredTools.includes(tool.name)) declaredTools.push(tool.name)
  }
  if (holder && !declaredTools.includes('env_request')) declaredTools.push('env_request')
  const { toolNames, customTools: phiCustomTools } = resolveAgentTools(
    declaredTools,
    availableTools
  )
  const phiCustomToolsByName = new Map(phiCustomTools.map((tool) => [tool.name, tool]))
  const customTools: CustomTool[] = []
  for (const name of toolNames) {
    const phiTool = phiCustomToolsByName.get(name)
    if (phiTool) {
      customTools.push(toOmpCustomTool(phiTool))
      continue
    }
    const ompTool = remoteMcpToolsByName.get(name)
    if (ompTool) customTools.push(ompTool)
  }
  const parentSession = deps.parent()?.session
  const parentModel = parentSession?.model || undefined
  let model = parentModel
  if (runtimeDefinition.model && runtimeDefinition.model.length > 0) {
    const selection = await selectAgentModel(
      runtimeDefinition.name,
      runtimeDefinition.model,
      async (selector) => {
        const slash = selector.indexOf('/')
        if (slash <= 0 || slash >= selector.length - 1) return undefined
        try {
          return await modelBySelector(ctx, {
            provider: selector.slice(0, slash),
            id: selector.slice(slash + 1)
          })
        } catch {
          // An unusable selector (for example an unavailable Cursor bridge) falls
          // through to the next one, then to the conversation's model.
          return undefined
        }
      },
      parentModel
    )
    if (selection.warning) process.stderr.write(`${selection.warning}\n`)
    model = selection.model
  }
  const thinkingLevel = runtimeDefinition.thinkingLevel
    ? runtimeThinkingLevel(runtimeDefinition.thinkingLevel)
    : parentSession?.thinkingLevel
  const result = await createAgentSession({
    agentId: `phi-agent-${sessionId}-${randomUUID()}`,
    agentDisplayName: runtimeDefinition.name,
    cwd: sessionCwd,
    agentDir,
    settings,
    authStorage: ctx.authStorage,
    modelRegistry: ctx.modelRegistry,
    sessionManager: SessionManager.inMemory(sessionCwd),
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(loader ? { resourceLoader: loader } : {}),
    ...(skills ? { skills } : {}),
    appendSystemPrompt: `${runtimeDefinition.systemPrompt}${deps.remoteRoot ? `\n\nRemote project root: ${JSON.stringify(deps.remoteRoot)}.` : ''}\n\n${AGENT_REPORT_PROTOCOL}`,
    ...(customTools.length > 0 ? { customTools } : {}),
    toolNames,
    restrictToolNames: true,
    // Without this the restriction also drops our Phi tool functions.
    allowRestrictedCustomTools: true,
    // Restricted specialists cannot let the SDK discover tools itself; verified remote
    // MCP tools are injected above from the parent manager under the same guard state.
    enableMCP: Boolean(deps.remoteRoot),
    enableLsp: false,
    ...(deps.remoteRoot
      ? {
          disableExtensionDiscovery: true,
          includeWorkspaceTree: false,
          contextFiles: deps.remoteContextFiles ?? [],
          promptTemplates: [],
          slashCommands: []
        }
      : {})
  })

  // The installer disposes the session and rethrows when the guards cannot be installed.
  await installSpecialistToolCallExtensions(result.session, toolCallFactories, sessionCwd)
  if (deps.remoteRoot) {
    await initializeAgentExtensions(result.session, {
      reportSendError: () =>
        process.stderr.write('Phi remote specialist extension message failed\n'),
      reportRuntimeError: () =>
        process.stderr.write('Phi remote specialist extension handler failed\n')
    })
    const verified = remoteWorkspaceToolsVerified(
      result.session.getAllToolInfos(),
      runtimeDefinition.tools
    )
    if (!verified) {
      await result.session.dispose()
      throw new Error('远程专家文件/命令工具未覆盖本地实现；专家会话已拒绝启动')
    }
  }
  return result.session as unknown as AgentSessionLike
}

/** A delegation card steers or stops the agent run it shows (see agent/agents/run-control.ts). */
export async function controlSessionAgentRun(
  action: 'steer' | 'stop',
  params: unknown
): Promise<{ ok: true }> {
  const record = isRecord(params) ? params : {}
  return controlAgentRun(sessions.get(stringValue(record.sessionId))?.agentRuns, action, record)
}

export async function listSessionAgentRuns(): Promise<unknown[]> {
  return [...sessions.entries()].flatMap(([agentSessionId, entry]) =>
    (entry.agentRuns?.list() ?? [])
      .filter((run) => run.background)
      .map((run) => ({
        agentSessionId,
        agentRunId: run.id,
        agentName: run.agent,
        task: run.task,
        state: run.state,
        background: run.background,
        startedAt: run.startedAt,
        ...(run.completedAt !== undefined ? { completedAt: run.completedAt } : {}),
        ...(run.lastStep ? { lastStep: run.lastStep } : {}),
        ...(run.toolCalls !== undefined ? { toolCalls: run.toolCalls } : {}),
        ...(run.toolCallId ? { toolCallId: run.toolCallId } : {})
      }))
  )
}
