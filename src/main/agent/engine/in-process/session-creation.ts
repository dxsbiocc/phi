import { randomUUID } from 'node:crypto'
import { Settings, type CreateAgentSessionResult } from '@oh-my-pi/pi-coding-agent'
import {
  createMainSessionExtensions,
  createPlanStepsExtension,
  remoteWorkspaceToolsVerified,
  type PhiExtensionConfig
} from '../phi-extension'
import { toOmpCustomTool } from '../tool-adapter'
import { applyAutoCompactionOverrides, createPhiSettings } from './settings'
import { projectMemoryPromptBlock } from '../../memory/project-memory-worker'
import { normalizeProjectMemorySettings } from '../../../../shared/projectMemoryTypes'
import { type EnvironmentLease } from '../../envs/leases'
import { buildRemoteMcpGuardState } from '../../mcp/remote-mcp-policy'
import { remoteProjectMcpRuntimeServersValue } from '../../mcp/remote-project-mcp-runtime'
import { disableFeaturedApiKeyAutoDiscovery } from '../../mcp-connectors'
import {
  BrowserTextVault,
  installBrowserTextPreDispatchRedaction
} from '../../browser/browser-text-vault'
import { isPhiAgentDefinition } from '../../agents/definition'
import { AgentRunRegistry } from '../../agents/registry'
import {
  buildPhiMainSystemPrompt,
  buildPhiRemoteProjectSystemPrompt
} from '../../main-system-prompt'
import { resolveRemoteRuntimePromptContext } from '../../remote-runtime-context'
import { translateOmpEvent } from '../events'
import { createCursorStreamRecoveryExtension } from '../phi-extension/extensions/cursor-stream-recovery'
import { createSpecialistFallbackExtension } from '../phi-extension/extensions/specialist-fallback'
import { isRecord, stringValue } from './common'
import { createInProcessExtensionHost, phiExtensionAgents } from './extension-host'
import { requestHost, sendEvent } from './ipc'
import { disconnectLeasedMcpManager, leasedProfileMcpManager } from './mcp-profile'
import { refreshRemoteMcpAccess, syncFeaturedApiKeysForSession } from './mcp-runtime'
import { getContext, modelBySelector, runtimeThinkingLevel } from './runtime-context'
import {
  createAgentSession,
  initializeAgentExtensions,
  makeSessionManager
} from './session-factory'
import { autoCompactionOverrides } from './session-runtime'
import { RemoteMcpAccess, sessions } from './state'
import { createSessionToolRegistry } from './tool-registry'
import { serializeSessionState } from './tool-support'

export async function createSession(params: unknown): Promise<unknown> {
  const record = isRecord(params) ? params : {}
  const sessionId = stringValue(record.sessionId, randomUUID())
  const cwd = stringValue(record.cwd, process.cwd())
  const agentDir = stringValue(record.agentDir, process.env.PI_CODING_AGENT_DIR)
  const remoteRecord = isRecord(record.remoteProject) ? record.remoteProject : null
  const remoteLocation =
    remoteRecord && isRecord(remoteRecord.location) ? remoteRecord.location : null
  const remoteRoot =
    remoteLocation?.kind === 'ssh' &&
    typeof remoteLocation.remoteRoot === 'string' &&
    remoteLocation.remoteRoot.startsWith('/') &&
    typeof remoteLocation.canonicalRoot === 'string' &&
    remoteLocation.canonicalRoot.startsWith('/') &&
    typeof remoteLocation.hostProfileId === 'string' &&
    remoteLocation.hostProfileId.length > 0 &&
    typeof remoteRecord?.projectId === 'string' &&
    typeof remoteRecord.phiSessionId === 'string' &&
    remoteRecord.phiSessionId.length > 0
      ? remoteLocation.remoteRoot
      : null
  if (record.remoteProject !== undefined && !remoteRoot) {
    throw new Error('Invalid remote project session context')
  }
  const remoteContextFiles =
    remoteRoot &&
    Array.isArray(remoteRecord?.contextFiles) &&
    remoteRecord.contextFiles.length <= 3 &&
    remoteRecord.contextFiles.every(
      (file) =>
        isRecord(file) &&
        typeof file.path === 'string' &&
        file.path.startsWith('ssh://') &&
        typeof file.content === 'string' &&
        Buffer.byteLength(file.content, 'utf-8') <= 64 * 1024
    )
      ? (remoteRecord.contextFiles as Array<{ path: string; content: string }>)
      : null
  if (remoteRoot && !remoteContextFiles) {
    throw new Error('Invalid remote project instruction context')
  }
  const remoteProjectIdentity = remoteRoot
    ? {
        sessionId: stringValue(remoteRecord?.phiSessionId),
        projectId: stringValue(remoteRecord?.projectId)
      }
    : undefined
  const remoteProjectMcpServers = remoteRoot
    ? remoteProjectMcpRuntimeServersValue(record.remoteProjectMcpServers, agentDir)
    : []
  const remoteRuntimeRecord = isRecord(record.remoteRuntimeRoot)
    ? record.remoteRuntimeRoot
    : undefined
  const projectRuntimeOverride =
    remoteRuntimeRecord?.source === 'project' && typeof remoteRuntimeRecord.configured === 'string'
      ? remoteRuntimeRecord.configured
      : undefined
  const remoteRuntime = remoteRoot
    ? resolveRemoteRuntimePromptContext(
        {
          hostProfileId: stringValue(remoteLocation?.hostProfileId),
          canonicalRoot: stringValue(remoteLocation?.canonicalRoot),
          ...(projectRuntimeOverride ? { projectOverride: projectRuntimeOverride } : {})
        },
        agentDir
      )
    : undefined
  const ctx = await getContext(agentDir)
  const settingsCwd = remoteRoot ? agentDir : cwd
  const baseSettings = await Settings.init({ cwd: settingsCwd, agentDir })
  const settings = await baseSettings.cloneForCwd(settingsCwd)
  applyAutoCompactionOverrides(settings, autoCompactionOverrides(record.autoCompaction))
  // Memory is keyed by the session manager cwd: the project directory, or the remote
  // project's local anchor. Summaries and lessons stay on this computer.
  const memoryPolicy = normalizeProjectMemorySettings(record.memory)
  const memoryTarget = memoryPolicy.enabled ? { agentDir, cwd } : undefined
  if (memoryTarget) createPhiSettings(settings).memory.useLocalBackend()
  const remoteMemoryBlock =
    remoteRoot && memoryTarget
      ? await projectMemoryPromptBlock(memoryTarget).catch(() => undefined)
      : undefined
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
  const remoteSkillToolNames = new Set<string>()
  const remoteMcpAccess: RemoteMcpAccess | undefined = remoteRoot
    ? { localProjectAnchor: cwd }
    : undefined
  const agentPolicies = phiExtensionAgents(phiAgents)
  const extensionConfig: PhiExtensionConfig = {
    cwd,
    projectBound: Boolean(record.projectBound),
    remote: Boolean(remoteRoot),
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
    agentRuns,
    remoteSkillToolNames: () => remoteSkillToolNames,
    remoteAgentDefinitions: () => phiAgents,
    remoteMcpToolState: () => remoteMcpAccess?.state
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
      remoteProjectIdentity,
      remoteRoot,
      remoteRecord,
      ctx,
      parentRef,
      remoteContextFiles,
      remoteMcpAccess,
      browserTextVault,
      memoryPolicy,
      memoryTarget,
      agentRuns,
      phiAgents,
      onAgentsChanged: () => {
        agentPolicies.splice(0, agentPolicies.length, ...phiExtensionAgents(phiAgents))
      },
      remoteSkillToolNames
    })

  const selectedModel = await modelBySelector(ctx, record.model)
  const leasedMcp = !noTools
    ? await leasedProfileMcpManager(
        agentDir,
        cwd,
        settings,
        ctx.authStorage,
        remoteRoot ? cwd : undefined,
        remoteProjectMcpServers
      )
    : undefined
  const mcpLeases = leasedMcp?.leases ?? new Map<string, EnvironmentLease>()
  let created: CreateAgentSessionResult | undefined
  try {
    const mcpTools = leasedMcp ? (await leasedMcp.manager.discoverAndConnect()).tools : undefined
    if (remoteMcpAccess && leasedMcp?.remotePolicy) {
      remoteMcpAccess.projectPolicy = leasedMcp.projectPolicy
      remoteMcpAccess.state = buildRemoteMcpGuardState(leasedMcp.remotePolicy, mcpTools ?? [], {
        agentDir,
        localProjectAnchor: remoteMcpAccess.localProjectAnchor
      })
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
      systemPrompt: (defaultPrompt) =>
        remoteRoot
          ? buildPhiRemoteProjectSystemPrompt(defaultPrompt, cwd, remoteRoot, {
              ...(personaMarkdown ? { personaMarkdown } : {}),
              ...(remoteRuntime ? { runtime: remoteRuntime } : {}),
              ...(remoteMemoryBlock ? { memoryBlock: remoteMemoryBlock } : {})
            })
          : buildPhiMainSystemPrompt(defaultPrompt, {
              ...(personaMarkdown ? { personaMarkdown } : {})
            }),
      ...(selectedModel ? { model: selectedModel } : {}),
      ...(resources ? { resourceLoader: resources } : {}),
      ...(customTools.length > 0 ? { customTools: customTools.map(toOmpCustomTool) } : {}),
      ...(remoteRoot
        ? {
            enableMCP: true,
            enableLsp: false,
            disableExtensionDiscovery: true,
            includeWorkspaceTree: false,
            contextFiles: remoteContextFiles ?? [],
            promptTemplates: [],
            slashCommands: []
          }
        : {}),
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
        if (remoteMcpAccess) refreshRemoteMcpAccess(remoteMcpAccess, agentDir, tools)
        return result.session.refreshMCPTools(tools)
      })
    }

    if (!noTools) await syncFeaturedApiKeysForSession(result, agentDir, undefined, remoteMcpAccess)

    if (remoteRoot) {
      await initializeAgentExtensions(result.session, {
        reportSendError: () => {
          process.stderr.write('Phi remote extension message failed\n')
        },
        reportRuntimeError: () => {
          process.stderr.write('Phi remote extension handler failed\n')
        }
      })
    }

    installBrowserTextPreDispatchRedaction(result.session, browserTextVault)

    if (remoteRoot && !remoteWorkspaceToolsVerified(result.session.getAllToolInfos())) {
      await result.session.dispose()
      throw new Error(
        '远程 read/bash/glob/grep/write/edit 工具未覆盖本地实现；远程会话已拒绝启动工具'
      )
    }

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
      ...(remoteMcpAccess ? { remoteMcpAccess } : {}),
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
