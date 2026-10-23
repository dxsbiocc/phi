import { join } from 'node:path'
import { type CreateAgentSessionResult, type ExtensionFactory } from '@oh-my-pi/pi-coding-agent'
import { mainSkillEnablementOptions } from '../main-skill-enablement'
import { buildProjectDownloadTool } from '../../download/project-download-tool'
import { buildPresentFilesTool } from '../../deliverables/present-tool'
import { buildRenderBlocksTool } from '../../deliverables/render-blocks-tool'
import { buildWorkerProjectLearnTool } from '../../memory/project-memory-worker'
import { normalizeProjectMemorySettings } from '../../../../shared/projectMemoryTypes'
import type { PresentedFile } from '../../../../shared/presentedFileTypes'
import { buildLibraryCustomTools } from '../../library/library-tools'
import { buildPaletteRecommendationTool } from '../../palettes/tools'
import { buildSessionNotebookTools } from './session-notebook-tools'
import { buildAskUserQuestionCustomTools } from '../../user-interaction-tools'
import { buildBrowserTool } from '../../browser/browser-tool'
import { BrowserTextVault } from '../../browser/browser-text-vault'
import { BrowserOutcome } from '../../../../shared/browserTypes'
import { type PhiAgentDefinition } from '../../agents/definition'
import { discoverPhiAgents } from '../../agents/discovery'
import { type PhiTool } from '../types'
import { AGENT_RUN_HOST_METHODS } from '../../agents/run-host'
import { AgentRunRegistry } from '../../agents/registry'
import { buildAgentRunTools } from '../../agents/run-tools'
import { createAgentRunner } from '../../agents/runner'
import { appendAgentUsageRecord, pruneAgentUsageLogs } from '../../agents/usage-log'
import { buildAgentTool } from '../../agents/tool'
import { filterPersonaContextFile } from '../../main-system-prompt'
import { buildEnvRequestTool } from '../../content/env-request-tool'
import { buildScriptTools, buildSkillRunTool } from '../../content/skill-tools'
import { buildCapabilityTools } from '../../packages/capability-tools'
import { readDirectSkills } from '../../runtime/direct-skills'
import { filterEnabledMainSkills, filterMainScriptTools } from '../../enablement'
import { RuntimeContext, UnknownRecord, isRecord } from './common'
import { requestHost } from './ipc'
import { resourceOptions } from './resources'
import { mergeRemoteProjectSkills } from '../remote-project-skills'
import { DefaultResourceLoader, SettingsManager } from './session-factory'
import { sessions } from './state'
import { applyConnectorEnabledForSession } from './mcp-runtime'
import {
  createCapabilityToolRegistrar,
  createLiveSkillSnapshot,
  installedCapabilitySkillFiles,
  isInstalledCapabilitySkillFile,
  refreshInstalledCapabilities
} from './capability-refresh'
import { createPhiAgentSession } from './subagents'
import { loadSkillScriptTools } from './tool-support'
import { buildDecisionTool } from '../../decisions/tool'
import { bindSessionDecisionEvaluator } from '../decision-evaluator'
import { evaluateDecisionRequest } from './decision-runtime'

export async function createSessionToolRegistry(deps: {
  record: UnknownRecord
  sessionId: string
  cwd: string
  agentDir: string
  settingsCwd: string
  personaMarkdown: string
  extensionFactories: ExtensionFactory[]
  ctx: RuntimeContext
  parentRef: { current?: CreateAgentSessionResult }
  browserTextVault: BrowserTextVault
  memoryPolicy: ReturnType<typeof normalizeProjectMemorySettings>
  memoryTarget?: { agentDir: string; cwd: string }
  agentRuns: AgentRunRegistry
  phiAgents: PhiAgentDefinition[]
  onAgentsChanged?: () => void
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
    ctx,
    parentRef,
    browserTextVault,
    memoryPolicy,
    memoryTarget,
    agentRuns,
    phiAgents,
    onAgentsChanged
  } = deps
  const liveSkills = createLiveSkillSnapshot<
    ReturnType<DefaultResourceLoader['getSkills']>['skills'][number]
  >((skills) => filterEnabledMainSkills(skills, mainSkillEnablementOptions(cwd, agentDir)))
  const capabilityRegistrar = createCapabilityToolRegistrar(() => parentRef.current?.session)
  const sessionExtensionFactories = [...extensionFactories, capabilityRegistrar.extension]
  let sessionResourceOptions = record.resourceOptions
  const contentResourceOptions = resourceOptions({
    ...(isRecord(record.resourceOptions) ? record.resourceOptions : {}),
    cwd: settingsCwd,
    agentDir
  })
  const resources =
    isRecord(record.resourceOptions) || sessionExtensionFactories.length > 0
      ? new DefaultResourceLoader({
          ...contentResourceOptions,
          settingsManager: SettingsManager.create(settingsCwd, agentDir),
          skillsOverride: (base) => {
            const resolved = contentResourceOptions.skillsOverride?.(base) ?? base
            const installed = contentResourceOptions.noSkills
              ? []
              : readDirectSkills(installedCapabilitySkillFiles(agentDir, cwd))
            const installedPaths = new Set(installed.map((skill) => skill.filePath))
            const available = resolved.skills.filter(
              (skill) => !isInstalledCapabilitySkillFile(skill.filePath, agentDir)
            )
            const merged = mergeRemoteProjectSkills(
              available.filter((skill) => !installedPaths.has(skill.filePath)),
              installed,
              resolved.skills.filter((skill) => skill.source === 'server-project')
            )
            return {
              ...resolved,
              skills: liveSkills.sync(merged)
            }
          },
          ...(personaMarkdown
            ? {
                agentsFilesOverride: (base) =>
                  filterPersonaContextFile(base, join(agentDir, 'AGENTS.md'))
              }
            : {}),
          extensionFactories: sessionExtensionFactories
        })
      : undefined

  if (resources) {
    await resources.reload()
  }

  // Initial tools use the SDK customTools option. The capability extension above
  // only registers additions after an approved installation while the run continues.
  // Never let a wrapper-catalog problem block an otherwise-ordinary chat
  // session from starting.
  // The main agent leads: it gets one delegation tool per scanned Phi agent,
  // named after the agent (for example `Wrapper`), and none of
  // the specialists' own tool functions, so internal catalogs and query tools
  // stay out of the main conversation. Definitions come from the main process's scan.
  // A failed listing is logged and registers nothing; it must not block the session.
  let skillTools = await loadSkillScriptTools(cwd)
  const mainSkillTools = skillTools
    ? filterMainScriptTools(skillTools, liveSkills.allowedSkills)
    : undefined
  if (phiAgents.length > 0) pruneAgentUsageLogs(agentDir)
  const decide = bindSessionDecisionEvaluator({
    agentDir,
    sessionId,
    currentModel: () => parentRef.current?.session.model,
    evaluate: evaluateDecisionRequest
  })
  const createAgentTool = (definition: PhiAgentDefinition): PhiTool =>
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
            resourceOptions: sessionResourceOptions,
            enableToolApproval: Boolean(record.enableToolApproval),
            ...(runId ? { agentRunId: runId } : {}),
            ...(skillTools ? { skillTools } : {}),
            parent: () => parentRef.current
          })
      }),
      agentRuns,
      { cwd, assessTask: decide }
    )
  const agentCustomTools = phiAgents.map(createAgentTool)
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
  const notebookCustomTools = buildSessionNotebookTools(requestHost, sessionId)
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
  const customTools = [
    buildDecisionTool(decide),
    ...agentCustomTools,
    ...agentRunTools,
    buildPresentFilesTool(
      sessionId,
      (request) =>
        requestHost('deliverables.present', request) as Promise<{ files: PresentedFile[] }>
    ),
    buildRenderBlocksTool(),
    ...(memoryPolicy.learn && memoryTarget ? [buildWorkerProjectLearnTool(memoryTarget)] : []),
    buildProjectDownloadTool(cwd, agentDir),
    ...notebookCustomTools,
    ...libraryCustomTools,
    buildPaletteRecommendationTool(),
    ...userInteractionCustomTools,
    buildEnvRequestTool(requestHost, {
      runtimeSessionId: sessionId,
      requireEnvironment: true
    }),
    ...buildCapabilityTools(requestHost, {
      runtimeSessionId: sessionId,
      onInstalled: (result, signal) =>
        refreshInstalledCapabilities(
          result,
          {
            reloadResources: async () => {
              if (!resources || !parentRef.current || sessions.get(sessionId)?.disposing) {
                throw new Error('当前任务已关闭，无法加载新模块')
              }
              const files = installedCapabilitySkillFiles(agentDir, cwd)
              const previous = isRecord(sessionResourceOptions) ? sessionResourceOptions : {}
              const previousFiles = Array.isArray(previous.additionalSkillFiles)
                ? previous.additionalSkillFiles.filter(
                    (file): file is string => typeof file === 'string'
                  )
                : []
              sessionResourceOptions = {
                ...previous,
                additionalSkillFiles: [
                  ...new Set([
                    ...previousFiles.filter(
                      (file) => !isInstalledCapabilitySkillFile(file, agentDir)
                    ),
                    ...files
                  ])
                ]
              }
              await resources.reload()
            },
            refreshSkills: async () => {
              await parentRef.current?.session.refreshSkills()
            },
            refreshTools: async (signal) => {
              const refreshed = await loadSkillScriptTools(cwd)
              if (!refreshed) throw new Error('无法读取已安装模块的脚本工具')
              signal?.throwIfAborted()
              skillTools = refreshed
              const enabled = filterMainScriptTools(refreshed, liveSkills.allowedSkills)
              const discovered = discoverPhiAgents({
                cwd,
                agentDir
              }).agents.filter(
                (agent) => !phiAgents.some((existing) => existing.name === agent.name)
              )
              const tools = [
                buildSkillRunTool(requestHost, {
                  runtimeSessionId: sessionId,
                  allowedSkills: liveSkills.allowedSkills
                }),
                ...buildScriptTools(
                  enabled.filter((tool) => tool.attachTo.includes('main')),
                  requestHost,
                  sessionId
                ),
                ...discovered.map(createAgentTool),
                ...(discovered.length > 0 && phiAgents.length === 0
                  ? buildAgentRunTools(agentRuns)
                  : [])
              ]
              const added = new Set(await capabilityRegistrar.register(tools, signal))
              customTools.push(...tools.filter((tool) => added.has(tool.name)))
              phiAgents.push(...discovered.filter((agent) => added.has(agent.name)))
              onAgentsChanged?.()
            },
            refreshConnector: async (name) => {
              const entry = sessions.get(sessionId)
              if (!entry || entry.disposing) throw new Error('当前任务已关闭，无法加载新连接器')
              await applyConnectorEnabledForSession(entry, name)
            }
          },
          signal
        )
    }),
    ...(mainSkillTools
      ? [
          buildSkillRunTool(requestHost, {
            runtimeSessionId: sessionId,
            allowedSkills: liveSkills.allowedSkills
          }),
          ...buildScriptTools(
            mainSkillTools.filter((tool) => tool.attachTo.includes('main')),
            requestHost,
            sessionId
          )
        ]
      : []),
    browserCustomTool
  ]

  return { resources, customTools, stopAgentRunNotices }
}
