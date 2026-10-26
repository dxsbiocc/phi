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
import {
  contextForModelAccess,
  getContext,
  modelBySelector,
  runtimeThinkingLevel
} from './runtime-context'
import type { RuntimeContext } from './common'
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
import { loadDesktopMcpHostTools } from './desktop-mcp-host-tools'
import type { KernelRuntimeServices } from './kernel-services'

type McpRefreshSession = Pick<
  CreateAgentSessionResult['session'],
  'refreshMCPTools' | 'setPendingMCPDiscovery'
>

/** Make a live MCP schema refresh part of next-turn prompt admission. */
export function scheduleMcpToolRefresh(
  session: McpRefreshSession,
  tools: Parameters<McpRefreshSession['refreshMCPTools']>[0]
): ReturnType<McpRefreshSession['refreshMCPTools']> {
  const refresh = session.refreshMCPTools(tools)
  session.setPendingMCPDiscovery(refresh)
  return refresh
}

export async function createSession(
  params: unknown,
  dependencies: {
    preparedSessionManager?: SessionManager
    modelAccess?: Pick<RuntimeContext, 'authStorage' | 'modelRegistry'> & {
      requestFetch?: typeof globalThis.fetch
    }
    kernelServices?: KernelRuntimeServices
  } = {}
): Promise<unknown> {
  const preparedSessionManager = dependencies.preparedSessionManager
  const record = isRecord(params) ? params : {}
  const sessionId = stringValue(record.sessionId, randomUUID())
  const cwd = stringValue(record.cwd, process.cwd())
  const agentDir = stringValue(record.agentDir, process.env.PI_CODING_AGENT_DIR)
  assertInProcessLocalProject({ ...record, cwd, agentDir })
  const ctx = dependencies.modelAccess
    ? contextForModelAccess(agentDir, dependencies.modelAccess)
    : await getContext(agentDir)
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
  const desktopMcpBinding = isRecord(record.desktopMcp)
    ? stringValue(record.desktopMcp.bindingId)
    : ''
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
  const agentRuns = new AgentRunRegistry({
    ...(dependencies.kernelServices?.agentRuns
      ? { admission: dependencies.kernelServices.agentRuns.admission(sessionId) }
      : {})
  })
  const stopKernelAgentRunNotices = dependencies.kernelServices?.agentRuns
    ? agentRuns.subscribe(dependencies.kernelServices.agentRuns.listener(sessionId))
    : undefined
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
      loader: () => sessionResourceLoader.current,
      includeSkills: !noTools
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
  const {
    resources,
    customTools,
    agentRunners,
    stopAgentRunNotices,
    reloadAgents,
    applyResourceReload
  } = registry

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
  let desktopMcp: Awaited<ReturnType<typeof loadDesktopMcpHostTools>> | undefined
  try {
    const mcpTools = leasedMcp ? (await leasedMcp.manager.discoverAndConnect()).tools : undefined
    if (!noTools && desktopMcpBinding) {
      desktopMcp = await loadDesktopMcpHostTools({
        sessionId,
        cwd,
        bindingId: desktopMcpBinding,
        registeredToolNames: [
          ...customTools.map((tool) => tool.name),
          ...(mcpTools ?? []).map((tool) => tool.name)
        ]
      })
      customTools.push(...desktopMcp.tools)
    }
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
    if (dependencies.modelAccess?.requestFetch) {
      const upstream = result.session.agent.streamFn
      const requestFetch = dependencies.modelAccess.requestFetch
      result.session.agent.streamFn = (model, context, options) =>
        upstream(model, context, { ...options, fetch: requestFetch })
    }
    installAutoWorkModeBatchGuard(result.session.agent, workMode === 'auto')
    if (leasedMcp) {
      const desktopToolNames = new Set(desktopMcp?.tools.map((tool) => tool.name) ?? [])
      const withoutDesktopConflicts = <T extends { name: string }>(tools: readonly T[]): T[] =>
        tools.filter((tool) => !desktopToolNames.has(tool.name))
      await result.session.refreshMCPTools(withoutDesktopConflicts(mcpTools ?? []))
      leasedMcp.manager.setOnToolsChanged((tools) => {
        return scheduleMcpToolRefresh(result.session, withoutDesktopConflicts(tools))
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
      context: ctx,
      agentRuns,
      agentRunners,
      reloadAgents,
      applyResourceReload,
      stopAgentRunNotices,
      ...(stopKernelAgentRunNotices ? { stopKernelAgentRunNotices } : {}),
      ...(dependencies.kernelServices?.plans
        ? { kernelPlanRuntime: dependencies.kernelServices.plans }
        : {}),
      browserTextVault,
      mcpLeases,
      ...(desktopMcp ? { closeDesktopMcp: () => desktopMcp!.close() } : {}),
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
    stopKernelAgentRunNotices?.()
    try {
      await created?.session.dispose()
    } catch {
      /* Preserve the original creation error while completing owned cleanup. */
    } finally {
      await desktopMcp?.close().catch(() => undefined)
      await disconnectLeasedMcpManager(leasedMcp?.manager, leasedMcp?.transports)
      for (const lease of mcpLeases.values()) lease.release()
      if (!created && preparedSessionManager) {
        await preparedSessionManager.close().catch(() => undefined)
      }
    }
    throw error
  }
}
