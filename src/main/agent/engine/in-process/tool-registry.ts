import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { type CreateAgentSessionResult, type ExtensionFactory } from '@oh-my-pi/pi-coding-agent'
import { mainSkillEnablementOptions } from '../main-skill-enablement'
import { buildProjectDownloadTool } from '../../download/project-download-tool'
import { buildPresentFilesTool } from '../../deliverables/present-tool'
import { buildRenderBlocksTool } from '../../deliverables/render-blocks-tool'
import { buildWorkerProjectLearnTool } from '../../memory/project-memory-worker'
import { normalizeProjectMemorySettings } from '../../../../shared/projectMemoryTypes'
import {
  buildRemoteProjectDownloadTool,
  type RemoteDownloadBackend
} from '../../download/remote-project-download-tool'
import { buildRemotePresentFilesTool } from '../../deliverables/remote-present-tool'
import { PresentedFile } from '../../../../shared/presentedFileTypes'
import {
  buildRemoteWorkspaceCustomTools,
  buildRemoteWorkspaceRead
} from '../remote-workspace-custom-tools'
import { buildLibraryCustomTools } from '../../library/library-tools'
import { buildPaletteRecommendationTool } from '../../palettes/tools'
import { buildNotebookCustomTools } from '../../notebook/notebook-tools'
import { buildAskUserQuestionCustomTools } from '../../user-interaction-tools'
import { buildBrowserTool } from '../../browser/browser-tool'
import { BrowserTextVault } from '../../browser/browser-text-vault'
import { BrowserOutcome } from '../../../../shared/browserTypes'
import { type PhiAgentDefinition } from '../../agents/definition'
import { type PhiTool } from '../types'
import { AGENT_RUN_HOST_METHODS } from '../../agents/run-host'
import { AgentRunRegistry } from '../../agents/registry'
import { buildAgentRunTools } from '../../agents/run-tools'
import { createAgentRunner } from '../../agents/runner'
import { appendAgentUsageRecord, pruneAgentUsageLogs } from '../../agents/usage-log'
import { buildAgentTool } from '../../agents/tool'
import { remoteAgentToolRegistrationVerified } from '../phi-extension'
import { filterPersonaContextFile } from '../../main-system-prompt'
import { buildEnvRequestTool } from '../../content/env-request-tool'
import { buildScriptTools, buildSkillRunTool } from '../../content/skill-tools'
import { filterEnabledMainSkills, filterMainScriptTools } from '../../enablement'
import { RuntimeContext, UnknownRecord, isRecord, stringValue } from './common'
import { readLoadedSkillResource, requestHost } from './ipc'
import { resourceOptions } from './resources'
import { DefaultResourceLoader, SettingsManager } from './session-factory'
import { RemoteMcpAccess } from './state'
import { createPhiAgentSession } from './subagents'
import { loadSkillScriptTools } from './tool-support'

export async function createSessionToolRegistry(deps: {
  record: UnknownRecord
  sessionId: string
  cwd: string
  agentDir: string
  settingsCwd: string
  personaMarkdown: string
  extensionFactories: ExtensionFactory[]
  remoteProjectIdentity?: { sessionId: string; projectId: string }
  remoteRoot: string | null
  remoteRecord: UnknownRecord | null
  ctx: RuntimeContext
  parentRef: { current?: CreateAgentSessionResult }
  remoteContextFiles: Array<{ path: string; content: string }> | null
  remoteMcpAccess?: RemoteMcpAccess
  browserTextVault: BrowserTextVault
  memoryPolicy: ReturnType<typeof normalizeProjectMemorySettings>
  memoryTarget?: { agentDir: string; cwd: string }
  agentRuns: AgentRunRegistry
  phiAgents: PhiAgentDefinition[]
  remoteSkillToolNames: Set<string>
}): Promise<{
  resources: DefaultResourceLoader | undefined
  customTools: PhiTool[]
  stopAgentRunNotices: () => void
}> {
  const {
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
    remoteSkillToolNames
  } = deps
  let sessionSkillNames: Set<string> | undefined
  const contentResourceOptions = resourceOptions({
    ...(isRecord(record.resourceOptions) ? record.resourceOptions : {}),
    cwd: settingsCwd,
    agentDir
  })
  const resources =
    isRecord(record.resourceOptions) || extensionFactories.length > 0
      ? new DefaultResourceLoader({
          ...contentResourceOptions,
          settingsManager: SettingsManager.create(settingsCwd, agentDir),
          skillsOverride: (base) => {
            const resolved = contentResourceOptions.skillsOverride?.(base) ?? base
            if (!sessionSkillNames) {
              const enabled = new Set(
                filterEnabledMainSkills(
                  resolved.skills,
                  mainSkillEnablementOptions(cwd, agentDir, remoteRoot ?? undefined)
                ).map((skill) => skill.name)
              )
              sessionSkillNames = new Set(
                resolved.skills
                  .filter((skill) => skill.source === 'server-project' || enabled.has(skill.name))
                  .map((skill) => skill.name)
              )
            }
            return {
              ...resolved,
              skills: resolved.skills.filter((skill) => sessionSkillNames?.has(skill.name))
            }
          },
          ...(personaMarkdown
            ? {
                agentsFilesOverride: (base) =>
                  filterPersonaContextFile(base, join(agentDir, 'AGENTS.md'))
              }
            : {}),
          ...(extensionFactories.length > 0 ? { extensionFactories } : {})
        })
      : undefined

  if (resources) {
    await resources.reload()
  }

  // Registered via the SDK's `customTools` option, not `resources`'
  // `extensionFactories` — that path is the tool-call *approval* hook (see
  // `createBridgeToolApprovalExtension` above), unrelated to adding a new
  // LLM-callable tool. See docs/design/phi-wrapper-technical-design.md,
  // "Integration With The Existing Runtime (Confirmed By Milestone P1.0)".
  // Never let a wrapper-catalog problem block an otherwise-ordinary chat
  // session from starting.
  // The main agent leads: it gets one delegation tool per scanned Phi agent,
  // named after the agent (for example `Wrapper`), and none of
  // the specialists' own tool functions, so internal catalogs and query tools
  // stay out of the main conversation. Definitions come from the main process's scan.
  // A failed listing is logged and registers nothing; it must not block the session.
  const skillTools = await loadSkillScriptTools(
    cwd,
    remoteProjectIdentity
      ? {
          runtimeSessionId: sessionId,
          sessionId: remoteProjectIdentity.sessionId,
          projectId: remoteProjectIdentity.projectId
        }
      : undefined
  )
  const enabledMainSkillNames = new Set(
    resources?.getSkills().skills.map((skill) => skill.name) ?? []
  )
  const mainSkillTools = skillTools
    ? filterMainScriptTools(skillTools, enabledMainSkillNames)
    : undefined
  for (const tool of mainSkillTools ?? []) remoteSkillToolNames.add(tool.name)
  const remoteWorkspaceIdentity = {
    sessionId: remoteRecord?.phiSessionId,
    projectId: remoteRecord?.projectId
  }
  const remoteWorkspaceRead = remoteRoot
    ? buildRemoteWorkspaceRead(requestHost, remoteWorkspaceIdentity)
    : undefined
  if (phiAgents.length > 0) pruneAgentUsageLogs(agentDir)
  const agentCustomTools = phiAgents.map((definition) =>
    buildAgentTool(
      definition,
      createAgentRunner({
        agent: definition.name,
        // What each delegation cost, for judging prompt and tool changes; see agents/usage.ts.
        onUsage: (record) => appendAgentUsageRecord(agentDir, { ...record, sessionId }),
        createSession: ({ runId }) =>
          createPhiAgentSession(definition, {
            sessionId,
            cwd,
            agentDir,
            ctx,
            resourceOptions: record.resourceOptions,
            enableToolApproval: Boolean(record.enableToolApproval),
            ...(runId ? { agentRunId: runId } : {}),
            ...(remoteRoot
              ? {
                  remoteRoot,
                  ...(remoteProjectIdentity ? { remoteProject: remoteProjectIdentity } : {}),
                  remoteContextFiles: remoteContextFiles ?? [],
                  remoteTools: () => {
                    const registered = parentRef.current?.session.getAllToolInfos() ?? []
                    return customTools.filter(
                      (tool) =>
                        !tool.name.startsWith('mcp__') &&
                        remoteAgentToolRegistrationVerified(tool.name, registered)
                    )
                  },
                  remoteMcpTools: () => {
                    const names = remoteMcpAccess?.state?.allowedToolNames
                    return (parentRef.current?.mcpManager?.getTools() ?? []).filter((tool) =>
                      names?.has(tool.name)
                    )
                  },
                  remoteMcpToolState: () => remoteMcpAccess?.state,
                  ...(remoteWorkspaceRead ? { remoteRead: remoteWorkspaceRead } : {})
                }
              : {}),
            ...(skillTools ? { skillTools } : {}),
            parent: () => parentRef.current
          })
      }),
      agentRuns,
      { cwd, ...(remoteRoot ? { remote: true } : {}) }
    )
  )
  const agentRunTools = phiAgents.length > 0 ? buildAgentRunTools(agentRuns) : []
  // A background run outlives the tool call that started it, so its end is reported to the
  // main process, which owns the conversation: it notes it in the timeline and can wake the
  // main agent. A run whose report the agent already collected is reported as such, so it
  // is not announced a second time. Foreground runs are never announced: the agent waited.
  const stopAgentRunNotices = agentRuns.subscribe({
    onFinish: (run) => {
      if (!run.background) return
      void requestHost(AGENT_RUN_HOST_METHODS.finished, {
        originSessionId: sessionId,
        run
      }).catch(() => undefined)
    },
    // Its steps go to the card that shows it; a foreground run's steps already do, through
    // the tool call that is waiting on it.
    onStep: (run, step) => {
      if (!run.background) return
      void requestHost(AGENT_RUN_HOST_METHODS.step, {
        originSessionId: sessionId,
        run: { id: run.id, agent: run.agent, toolCallId: run.toolCallId },
        step
      }).catch(() => undefined)
    },
    onReported: (run) => {
      if (!run.background) return
      void requestHost(AGENT_RUN_HOST_METHODS.reported, {
        originSessionId: sessionId,
        runId: run.id
      }).catch(() => undefined)
    }
  })
  const notebookCustomTools = buildNotebookCustomTools(
    async (request) => requestHost('notebookTool.execute', request),
    remoteProjectIdentity
      ? {
          remoteProject: {
            runtimeSessionId: sessionId,
            sessionId: remoteProjectIdentity.sessionId,
            projectId: remoteProjectIdentity.projectId
          }
        }
      : {}
  )
  const libraryCustomTools = buildLibraryCustomTools()
  const userInteractionCustomTools = buildAskUserQuestionCustomTools(sessionId, async (request) =>
    requestHost('agentInteraction.request', request)
  )
  const browserCustomTool = buildBrowserTool(
    sessionId,
    (request) => requestHost('browser.execute', request) as Promise<BrowserOutcome>,
    {
      cancelHost: (identity) => requestHost('browser.cancel', identity),
      takeText: (toolCallId, placeholder) => browserTextVault.take(toolCallId, placeholder),
      allowTypeText: () => parentRef.current?.session.getPlanModeState()?.enabled !== true
    }
  )
  const remoteWorkspaceCustomTools = remoteWorkspaceRead
    ? buildRemoteWorkspaceCustomTools(requestHost, remoteWorkspaceIdentity, {
        read: remoteWorkspaceRead,
        readResource: (path) =>
          readLoadedSkillResource(path, resources?.getSkills().skills ?? [], remoteProjectIdentity)
      })
    : []
  const customTools = [
    ...remoteWorkspaceCustomTools,
    ...agentCustomTools,
    ...agentRunTools,
    ...(remoteRoot
      ? [
          buildRemotePresentFilesTool(
            sessionId,
            (request) =>
              requestHost('deliverables.present', request) as Promise<{ files: PresentedFile[] }>
          )
        ]
      : [
          buildPresentFilesTool(
            sessionId,
            (request) =>
              requestHost('deliverables.present', request) as Promise<{ files: PresentedFile[] }>
          )
        ]),
    buildRenderBlocksTool(),
    ...(memoryPolicy.learn && memoryTarget ? [buildWorkerProjectLearnTool(memoryTarget)] : []),
    remoteRoot
      ? buildRemoteProjectDownloadTool(
          remoteDownloadBackend({
            sessionId: stringValue(remoteRecord?.phiSessionId),
            projectId: stringValue(remoteRecord?.projectId)
          })
        )
      : buildProjectDownloadTool(cwd, agentDir),
    ...notebookCustomTools,
    ...libraryCustomTools,
    buildPaletteRecommendationTool(),
    ...userInteractionCustomTools,
    buildEnvRequestTool(requestHost, {
      runtimeSessionId: sessionId,
      requireEnvironment: true,
      ...(remoteProjectIdentity ? { remoteProject: remoteProjectIdentity } : {})
    }),
    ...(mainSkillTools
      ? [
          buildSkillRunTool(requestHost, {
            runtimeSessionId: sessionId,
            allowedSkills: [...enabledMainSkillNames],
            ...(remoteProjectIdentity ? { remoteProject: remoteProjectIdentity } : {})
          }),
          ...buildScriptTools(
            mainSkillTools.filter((tool) => tool.attachTo.includes('main')),
            requestHost,
            remoteProjectIdentity
              ? { runtimeSessionId: sessionId, remoteProject: remoteProjectIdentity }
              : sessionId
          )
        ]
      : []),
    browserCustomTool
  ]

  return { resources, customTools, stopAgentRunNotices }
}

export function remoteDownloadBackend(identity: {
  sessionId: string
  projectId: string
}): RemoteDownloadBackend {
  return async (request, signal) => {
    signal?.throwIfAborted()
    const requestId = randomUUID()
    const cancel = (): void => {
      void requestHost('remoteWorkspace.cancelDownload', { ...identity, requestId }).catch(
        () => undefined
      )
    }
    if (signal?.aborted) cancel()
    else signal?.addEventListener('abort', cancel, { once: true })
    try {
      return (await requestHost('remoteWorkspace.download', {
        ...identity,
        ...request,
        requestId
      })) as Awaited<ReturnType<RemoteDownloadBackend>>
    } finally {
      signal?.removeEventListener('abort', cancel)
    }
  }
}
