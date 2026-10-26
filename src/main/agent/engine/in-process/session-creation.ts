import { randomUUID } from 'node:crypto'
import {
  Settings,
  type CreateAgentSessionResult,
  type SessionManager
} from '@oh-my-pi/pi-coding-agent'
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
import { loadWorkerMcpRuntime } from './worker-subsystems'
import { getContext, modelBySelector, runtimeThinkingLevel } from './runtime-context'
import {
  createAgentSession,
  makeSessionManager,
  type DefaultResourceLoader
} from './session-factory'
import { autoCompactionOverrides, enterSessionPlanMode } from './session-runtime'
import { sessions } from './state'
import { createSessionToolRegistry } from './tool-registry'
import { serializeSessionState } from './tool-support'
import { installAutoWorkModeBatchGuard } from './auto-work-mode-guard'
import { createLiveResourcePromptExtension } from './live-resource-prompt'
import {
  bindSessionEnvironment,
  sessionContextFiles,
  sessionMcpServers
} from './session-resource-input'

export async function createSession(
  params: unknown,
  preparedSessionManager?: SessionManager
): Promise<unknown> {
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
  const noTools = record.noTools === 'all' || record.noTools === true
  if (!noTools) disableFeaturedApiKeyAutoDiscovery(agentDir)
  const resourceSnapshot = {
    personaMarkdown: stringValue(record.personaMarkdown).trim(),
    contextFiles: sessionContextFiles(record.contextFiles)
  }
  const mcpServers = sessionMcpServers(record.mcpServers)
  const environmentBinding = await bindSessionEnvironment(record.environment, {
    sessionId,
    cwd,
    request: requestHost
  })
  const sessionManager =
    preparedSessionManager ?? (await makeSessionManager(record.sessionManager, cwd, agentDir))
  const workMode =
    record.workMode === 'auto' ||
    record.workMode === 'direct' ||
    record.workMode === 'plan' ||
    record.workMode === 'plan_execute'
      ? record.workMode
      : 'direct'
  const phiAgents = Array.isArray(record.phiAgents)
    ? record.phiAgents.filter(isPhiAgentDefinition)
    : []
  // One registry per conversation: parallel and background delegations share its limits,
  // and the run tools and controlled-fallback policy below act on it.
  const agentRuns = new AgentRunRegistry()
  const parentRef: { current?: CreateAgentSessionResult } = {}
  const browserTextVault = new BrowserTextVault()
  const sessionResourceLoader: { current?: DefaultResourceLoader } = {}
  const agentPolicies = phiExtensionAgents(phiAgents)
  const extensionConfig: PhiExtensionConfig = {
    cwd,
    projectBound: Boolean(record.projectBound),
    enableToolApproval: Boolean(record.enableToolApproval),
    sessionId,
    useBrowserTextVault: true,
    workMode,
    ...(environmentBinding ? { environmentBinding } : {}),
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
    enterAutoPlanMode: async (input) => {
      if (workMode !== 'auto') throw new Error('Automatic work mode is not active')
      await enterSessionPlanMode({ sessionId, execute: input.execute })
      await requestHost('workMode.selected', input, { originSessionId: sessionId })
    },
    browserTextVault,
    agentRuns,
    environmentBinding: () => environmentBinding
  })
  const extensionFactories = [
    createLiveResourcePromptExtension({
      snapshot: resourceSnapshot,
      loader: () => sessionResourceLoader.current
    }),
    ...createMainSessionExtensions(extensionConfig, extensionHost),
    createPlanStepsExtension(extensionHost),
    // Keep a policy guard even when a later approved plugin supplies the first specialist.
    ...(agentPolicies.length === 0
      ? [createSpecialistFallbackExtension(agentPolicies, extensionHost)]
      : []),
    createCursorStreamRecoveryExtension(() => parentRef.current?.session.agent)
  ]
  const registry = await createSessionToolRegistry({
    record,
    sessionId,
    cwd,
    agentDir,
    settingsCwd,
    resourceSnapshot,
    environmentBinding,
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
  sessionResourceLoader.current = registry.resources
  const { resources, customTools, agentRunners, stopAgentRunNotices } = registry

  const selectedModel = await modelBySelector(ctx, record.model)
  const leasedMcp = !noTools
    ? await leasedProfileMcpManager(
        agentDir,
        cwd,
        settings,
        ctx.authStorage,
        undefined,
        [],
        mcpServers
          ? {
              serverNames: new Set(mcpServers.map((server) => server.name)),
              allowStdio: true,
              overrides: Object.fromEntries(
                mcpServers.map((server) => [server.name, server.config])
              )
            }
          : undefined
      )
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
      systemPrompt: (defaultPrompt) => buildPhiMainSystemPrompt(defaultPrompt, { workMode }),
      ...(selectedModel ? { model: selectedModel } : {}),
      ...(resources ? { resourceLoader: resources } : {}),
      // Snapshot-owned skills/context are injected by the live resource extension so a
      // reload can replace them without leaving revoked instructions in the base prompt.
      contextFiles: [],
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
    installAutoWorkModeBatchGuard(result.session.agent, workMode === 'auto')
    if (leasedMcp) {
      await result.session.refreshMCPTools(mcpTools ?? [])
      leasedMcp.manager.setOnToolsChanged((tools) => {
        return result.session.refreshMCPTools(tools)
      })
    }

    if (!noTools) {
      const { syncFeaturedApiKeysForSession } = await loadWorkerMcpRuntime()
      await syncFeaturedApiKeysForSession(result, agentDir)
    }

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
      ...(resources ? { resourceLoader: resources } : {}),
      resourceSnapshot,
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
      if (!created && preparedSessionManager) {
        await preparedSessionManager.close().catch(() => undefined)
      }
    }
    throw error
  }
}
