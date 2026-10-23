import { randomUUID } from 'node:crypto'
import { Settings, type CreateAgentSessionResult } from '@oh-my-pi/pi-coding-agent'
import {
  createMainSessionExtensions,
  createPlanStepsExtension,
  type PhiExtensionConfig
} from '../phi-extension'
import { toOmpCustomTool } from '../tool-adapter'
import { applyAutoCompactionOverrides, createPhiSettings } from './settings'
import { normalizeProjectMemorySettings } from '../../../../shared/projectMemoryTypes'
import { type EnvironmentLease } from '../../envs/leases'
import { disableFeaturedApiKeyAutoDiscovery } from '../../mcp-connectors'
import {
  BrowserTextVault,
  installBrowserTextPreDispatchRedaction
} from '../../browser/browser-text-vault'
import { isPhiAgentDefinition } from '../../agents/definition'
import { AgentRunRegistry } from '../../agents/registry'
import { buildPhiMainSystemPrompt } from '../../main-system-prompt'
import { translateOmpEvent } from '../events'
import { createCursorStreamRecoveryExtension } from '../phi-extension/extensions/cursor-stream-recovery'
import { createSpecialistFallbackExtension } from '../phi-extension/extensions/specialist-fallback'
import { isRecord, stringValue } from './common'
import { createInProcessExtensionHost, phiExtensionAgents } from './extension-host'
import { requestHost, sendEvent } from './ipc'
import { assertInProcessLocalProject } from './local-project-boundary'
import { disconnectLeasedMcpManager, leasedProfileMcpManager } from './mcp-profile'
import { syncFeaturedApiKeysForSession } from './mcp-runtime'
import { getContext, modelBySelector, runtimeThinkingLevel } from './runtime-context'
import { createAgentSession, makeSessionManager } from './session-factory'
import { autoCompactionOverrides } from './session-runtime'
import { sessions } from './state'
import { createSessionToolRegistry } from './tool-registry'
import { serializeSessionState } from './tool-support'

export async function createSession(params: unknown): Promise<unknown> {
  const record = isRecord(params) ? params : {}
  const sessionId = stringValue(record.sessionId, randomUUID())
  const cwd = stringValue(record.cwd, process.cwd())
  const agentDir = stringValue(record.agentDir, process.env.PI_CODING_AGENT_DIR)
  assertInProcessLocalProject({ ...record, cwd, agentDir })
  const ctx = await getContext(agentDir)
  const settingsCwd = cwd
  const baseSettings = await Settings.init({ cwd: settingsCwd, agentDir })
  const settings = await baseSettings.cloneForCwd(settingsCwd)
  applyAutoCompactionOverrides(settings, autoCompactionOverrides(record.autoCompaction))
  const memoryPolicy = normalizeProjectMemorySettings(record.memory)
  const memoryTarget = memoryPolicy.enabled ? { agentDir, cwd } : undefined
  if (memoryTarget) createPhiSettings(settings).memory.useLocalBackend()
  const sessionManager = await makeSessionManager(record.sessionManager, cwd, agentDir)
  const noTools = record.noTools === 'all' || record.noTools === true
  if (!noTools) disableFeaturedApiKeyAutoDiscovery(agentDir)
  const personaMarkdown = stringValue(record.personaMarkdown).trim()
  const phiAgents = Array.isArray(record.phiAgents)
    ? record.phiAgents.filter(isPhiAgentDefinition)
    : []
  // One registry per conversation: parallel and background delegations share its limits,
  // and the run tools and controlled-fallback policy below act on it.
  const agentRuns = new AgentRunRegistry()
  const parentRef: { current?: CreateAgentSessionResult } = {}
  const browserTextVault = new BrowserTextVault()
  const agentPolicies = phiExtensionAgents(phiAgents)
  const extensionConfig: PhiExtensionConfig = {
    cwd,
    projectBound: Boolean(record.projectBound),
    enableToolApproval: Boolean(record.enableToolApproval),
    sessionId,
    useBrowserTextVault: true,
    phiAgents: agentPolicies
  }
  const extensionHost = createInProcessExtensionHost({
    cwd,
    nextActionSuggestionsEnabled: async () =>
      (await requestHost('settings.nextActionSuggestionsEnabled', {})) === true,
    planModeActive: () => parentRef.current?.session.getPlanModeState()?.enabled === true,
    planExecuteModeActive: () => Boolean(sessions.get(sessionId)?.planStepsProposal),
    proposePlanSteps: async (input) => {
      const handler = sessions.get(sessionId)?.planStepsProposal
      if (!handler) throw new Error('Plan execution mode is not active')
      return handler(input)
    },
    browserTextVault,
    agentRuns
  })
  const extensionFactories = [
    ...createMainSessionExtensions(extensionConfig, extensionHost),
    createPlanStepsExtension(extensionHost),
    // Keep a policy guard even when a later approved plugin supplies the first specialist.
    ...(agentPolicies.length === 0
      ? [createSpecialistFallbackExtension(agentPolicies, extensionHost)]
      : []),
    createCursorStreamRecoveryExtension(() => parentRef.current?.session.agent)
  ]
  const { resources, customTools, agentRunners, stopAgentRunNotices } =
    await createSessionToolRegistry({
      record,
      sessionId,
      cwd,
      agentDir,
      settingsCwd,
      personaMarkdown,
      extensionFactories,
      ctx,
      parentRef,
      browserTextVault,
      memoryPolicy,
      memoryTarget,
      agentRuns,
      phiAgents,
      onAgentsChanged: () => {
        agentPolicies.splice(0, agentPolicies.length, ...phiExtensionAgents(phiAgents))
      }
    })

  const selectedModel = await modelBySelector(ctx, record.model)
  const leasedMcp = !noTools
    ? await leasedProfileMcpManager(agentDir, cwd, settings, ctx.authStorage)
    : undefined
  const mcpLeases = leasedMcp?.leases ?? new Map<string, EnvironmentLease>()
  let created: CreateAgentSessionResult | undefined
  try {
    const mcpTools = leasedMcp ? (await leasedMcp.manager.discoverAndConnect()).tools : undefined
    const result = await createAgentSession({
      agentId: `phi-main-${sessionId}`,
      agentDisplayName: 'Main',
      // The session manager retains the private history anchor. SDK discovery uses
      // Phi's global directory so it never treats that anchor as a project root.
      cwd: settingsCwd,
      agentDir,
      settings,
      authStorage: ctx.authStorage,
      modelRegistry: ctx.modelRegistry,
      sessionManager,
      ...(leasedMcp ? { mcpManager: leasedMcp.manager } : {}),
      thinkingLevel: runtimeThinkingLevel(record.thinkingLevel),
      systemPrompt: (defaultPrompt) =>
        buildPhiMainSystemPrompt(defaultPrompt, {
          ...(personaMarkdown ? { personaMarkdown } : {})
        }),
      ...(selectedModel ? { model: selectedModel } : {}),
      ...(resources ? { resourceLoader: resources } : {}),
      ...(customTools.length > 0 ? { customTools: customTools.map(toOmpCustomTool) } : {}),
      ...(noTools
        ? {
            enableMCP: false,
            enableLsp: false,
            disableExtensionDiscovery: true,
            toolNames: [],
            restrictToolNames: true,
            skills: [],
            contextFiles: [],
            promptTemplates: [],
            slashCommands: []
          }
        : {})
    })
    created = result
    if (leasedMcp) {
      await result.session.refreshMCPTools(mcpTools ?? [])
      leasedMcp.manager.setOnToolsChanged((tools) => {
        return result.session.refreshMCPTools(tools)
      })
    }

    if (!noTools) await syncFeaturedApiKeysForSession(result, agentDir)

    installBrowserTextPreDispatchRedaction(result.session, browserTextVault)

    parentRef.current = result

    result.session.subscribe((event) => {
      sendEvent('sessionEvent', translateOmpEvent(event, result.session), { sessionId })
      sendEvent('sessionState', serializeSessionState(result), { sessionId })
    })
    sessions.set(sessionId, {
      result,
      agentDir,
      agentRuns,
      agentRunners,
      stopAgentRunNotices,
      browserTextVault,
      mcpLeases,
      ...(leasedMcp
        ? { ownedMcpManager: leasedMcp.manager, ownedStdioTransports: leasedMcp.transports }
        : {})
    })
    return {
      sessionId,
      state: serializeSessionState(result)
    }
  } catch (error) {
    try {
      await created?.session.dispose()
    } catch {
      /* Preserve the original creation error while completing owned cleanup. */
    } finally {
      await disconnectLeasedMcpManager(leasedMcp?.manager, leasedMcp?.transports)
      for (const lease of mcpLeases.values()) lease.release()
    }
    throw error
  }
}
