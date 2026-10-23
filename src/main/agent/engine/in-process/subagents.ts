import { cfgBashAutoBackgroundEnabled } from '@oh-my-pi/pi-coding-agent/exec/settings'
import { randomUUID } from 'node:crypto'
import { SessionManager, Settings, type CreateAgentSessionResult } from '@oh-my-pi/pi-coding-agent'
import { createSpecialistExtensions, type PhiExtensionConfig } from '../phi-extension'
import { toOmpCustomTool } from '../tool-adapter'
import { adaptOmpSessionEvents } from '../events'
import { type PhiAgentDefinition } from '../../agents/definition'
import { selectAgentModel } from '../../agents/model-selection'
import { controlAgentRun } from '../../agents/run-control'
import { type AgentSessionLike } from '../../agents/runner'
import { resolveAgentTools } from '../../agents/tool-resolution'
import { installSpecialistToolCallExtensions } from './specialist-tool-call-extensions'
import { AGENT_REPORT_PROTOCOL } from '../../agents/report'
import { buildEnvRequestTool } from '../../content/env-request-tool'
import { buildScriptTools, buildSkillRunTool } from '../../content/skill-tools'
import { ScriptToolDescriptor } from '../../content/skill-tool-types'
import { selectDeclaredSpecialistSkills } from '../../enablement'
import { RuntimeContext, isRecord, stringValue } from './common'
import { createInProcessExtensionHost } from './extension-host'
import { requestHost } from './ipc'
import { assertInProcessLocalProject } from './local-project-boundary'
import { resourceOptions } from './resources'
import { modelBySelector, runtimeThinkingLevel } from './runtime-context'
import { createAgentSession, DefaultResourceLoader, SettingsManager } from './session-factory'
import { sessions } from './state'
import { createSessionModelAvailability } from './session-model-availability'
import { phiToolFunctions } from './tool-support'

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
  }
): Promise<{ ref: string; variables: Record<string, string>; pluginId?: string } | undefined> {
  const ref = definition.environment
  if (!ref) return undefined
  const result = await requestHost('environments.bindSession', {
    runtimeSessionId: deps.sessionId,
    ref,
    agent: definition.name,
    cwd: deps.cwd,
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
    skillTools?: ScriptToolDescriptor[]
    parent: () => CreateAgentSessionResult | undefined
  }
): Promise<AgentSessionLike> {
  const { sessionId, cwd, agentDir, ctx } = deps
  assertInProcessLocalProject(deps)
  const runtimeDefinition = definition
  const sessionCwd = cwd
  const binding = await bindSpecialistEnvironment(runtimeDefinition, deps)
  const holder = binding
    ? {
        ref: binding.ref,
        variables: { ...binding.variables },
        ...(binding.pluginId ? { pluginId: binding.pluginId } : {})
      }
    : undefined
  const extensionConfig: PhiExtensionConfig = {
    cwd: sessionCwd,
    projectBound: false,
    enableToolApproval: deps.enableToolApproval,
    sessionId,
    ...(deps.agentRunId ? { agentRunId: deps.agentRunId } : {}),
    useBrowserTextVault: false,
    ...(holder ? { environmentBinding: holder } : {}),
    phiAgents: []
  }
  const extensionHost = createInProcessExtensionHost({
    cwd: sessionCwd,
    planModeActive: () => deps.parent()?.session.getPlanModeState()?.enabled === true,
    environmentBinding: () => holder
  })
  // Order matters: guards and approval see the model input; the live environment
  // binding is last so its rewrite is the input that executes.
  const toolCallFactories = createSpecialistExtensions(extensionConfig, extensionHost)
  const skillHost = holder
    ? {
        runtimeSessionId: sessionId,
        environmentBinding: holder,
        ...(holder.pluginId ? { pluginId: holder.pluginId } : {})
      }
    : sessionId
  const settings = (await Settings.init({ cwd: sessionCwd, agentDir })).overlay()
  // OMP 18.10 gives every specialist an async manager. Automatic backgrounding
  // would turn ordinary calls into disposable job shells, losing the persistent
  // shell exports Phi specialists had on 18.1. Explicit async remains available.
  cfgBashAutoBackgroundEnabled.override(settings, false)
  const loader = isRecord(deps.resourceOptions)
    ? new DefaultResourceLoader({
        ...resourceOptions({
          ...(isRecord(deps.resourceOptions) ? deps.resourceOptions : {}),
          cwd: sessionCwd,
          agentDir
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
          ...(typeof skillHost === 'string' ? { runtimeSessionId: skillHost } : skillHost),
          allowedSkills: runtimeDefinition.skills
        })
      : undefined
  )
  const attachedScriptTools = buildScriptTools(
    (deps.skillTools ?? []).filter(
      (tool) =>
        runtimeDefinition.skills.includes(tool.skill) &&
        tool.attachTo.includes(runtimeDefinition.name)
    ),
    requestHost,
    skillHost
  )
  for (const tool of attachedScriptTools) availableTools.set(tool.name, tool)
  if (holder) {
    const envRequest = buildEnvRequestTool(requestHost, {
      runtimeSessionId: sessionId,
      binding: holder,
      agent: runtimeDefinition.name
    })
    availableTools.set(envRequest.name, envRequest)
  }
  const declaredTools = [...runtimeDefinition.tools]
  for (const tool of attachedScriptTools) {
    if (!declaredTools.includes(tool.name)) declaredTools.push(tool.name)
  }
  if (holder && !declaredTools.includes('env_request')) declaredTools.push('env_request')
  const { toolNames, customTools: phiCustomTools } = resolveAgentTools(
    declaredTools,
    availableTools
  )
  const customTools = phiCustomTools.map(toOmpCustomTool)
  const parentSession = deps.parent()?.session
  const modelPolicy = createSessionModelAvailability(ctx.modelRegistry, agentDir)
  const modelContext = { ...ctx, modelRegistry: modelPolicy.registry }
  const parentModel =
    parentSession?.model && modelPolicy.enabled(parentSession.model)
      ? parentSession.model
      : undefined
  let model = parentModel
  if (runtimeDefinition.model && runtimeDefinition.model.length > 0) {
    const selection = await selectAgentModel(
      runtimeDefinition.name,
      runtimeDefinition.model,
      async (selector) => {
        const slash = selector.indexOf('/')
        if (slash <= 0 || slash >= selector.length - 1) return undefined
        try {
          return await modelBySelector(modelContext, {
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
  if (!model) throw new Error('No enabled model available for this specialist')
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
    appendSystemPrompt: `${runtimeDefinition.systemPrompt}\n\n${AGENT_REPORT_PROTOCOL}`,
    ...(customTools.length > 0 ? { customTools } : {}),
    toolNames,
    restrictToolNames: true,
    // Without this the restriction also drops our Phi tool functions.
    allowRestrictedCustomTools: true,
    enableMCP: false,
    enableLsp: false
  })

  // The installer disposes the session and rethrows when the guards cannot be installed.
  await installSpecialistToolCallExtensions(result.session, toolCallFactories, sessionCwd)
  return adaptOmpSessionEvents(result.session)
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
        origin: run.origin ?? 'tool',
        startedAt: run.startedAt,
        ...(run.completedAt !== undefined ? { completedAt: run.completedAt } : {}),
        ...(run.lastStep ? { lastStep: run.lastStep } : {}),
        ...(run.toolCalls !== undefined ? { toolCalls: run.toolCalls } : {}),
        ...(run.toolCallId ? { toolCallId: run.toolCallId } : {})
      }))
  )
}
