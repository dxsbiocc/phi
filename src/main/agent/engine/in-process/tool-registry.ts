import { join } from 'node:path'
import { type CreateAgentSessionResult, type ExtensionFactory } from '@oh-my-pi/pi-coding-agent'
import { mainSkillEnablementOptions } from '../main-skill-enablement'
import { buildProjectDownloadTool } from '../../download/project-download-tool'
import { buildPresentFilesTool } from '../../deliverables/present-tool'
import { buildRenderBlocksTool } from '../../deliverables/render-blocks-tool'
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
import { AgentRunRegistry, type AgentRunFn } from '../../agents/registry'
import { createAgentRunner } from '../../agents/runner'
import { appendAgentUsageRecord, pruneAgentUsageLogs } from '../../agents/usage-log'
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
import { loadWorkerDecisionRuntime, loadWorkerMcpRuntime } from './worker-subsystems'
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
import { subscribeToAgentRunNotices } from './agent-run-notices'
import { buildSessionAgentDelegationTools, supportsDelegationTool } from './session-agent-tools'
import type { PhiExtensionEnvironmentBinding } from '../phi-extension'
import type { SessionResourceSnapshot } from './session-resource-input'

export async function createSessionToolRegistry(deps: {
  record: UnknownRecord
  sessionId: string
  cwd: string
  agentDir: string
  settingsCwd: string
  resourceSnapshot: SessionResourceSnapshot
  environmentBinding?: PhiExtensionEnvironmentBinding
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
  agentRunners: ReadonlyMap<string, AgentRunFn>
  stopAgentRunNotices: () => void
  applyResourceReload(params: unknown): void
  reloadAgents(
    definitions: PhiAgentDefinition[]
  ): Promise<
    | { applied: true; added: string[] }
    | { applied: false; reason: 'requires_session_refresh'; changed: string[] }
  >
}> {
  const {
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
    onAgentsChanged
  } = deps
  const liveSkills = createLiveSkillSnapshot<
    ReturnType<DefaultResourceLoader['getSkills']>['skills'][number]
  >((skills) => filterEnabledMainSkills(skills, mainSkillEnablementOptions(cwd, agentDir)))
  const runtimeSkills: ReturnType<DefaultResourceLoader['getSkills']>['skills'] = []
  const capabilityRegistrar = createCapabilityToolRegistrar(() => parentRef.current?.session)
  const sessionExtensionFactories = [...extensionFactories, capabilityRegistrar.extension]
  let sessionResourceOptions = record.resourceOptions
  const initialResourceOptions = resourceOptions({
    ...(isRecord(record.resourceOptions) ? record.resourceOptions : {}),
    cwd: settingsCwd,
    agentDir
  })
  const contentResourceOptions = {
    ...initialResourceOptions,
    additionalExtensionPaths: [...(initialResourceOptions.additionalExtensionPaths ?? [])],
    additionalSkillPaths: [...(initialResourceOptions.additionalSkillPaths ?? [])],
    additionalPromptTemplatePaths: [
      ...(initialResourceOptions.additionalPromptTemplatePaths ?? [])
    ],
    additionalThemePaths: [...(initialResourceOptions.additionalThemePaths ?? [])]
  }
  const applyResourceReload = (params: unknown): void => {
    const record = isRecord(params) ? params : {}
    const next = resourceOptions({ ...record, cwd: settingsCwd, agentDir })
    contentResourceOptions.additionalExtensionPaths.splice(
      0,
      contentResourceOptions.additionalExtensionPaths.length,
      ...(next.additionalExtensionPaths ?? [])
    )
    contentResourceOptions.additionalSkillPaths.splice(
      0,
      contentResourceOptions.additionalSkillPaths.length,
      ...(next.additionalSkillPaths ?? [])
    )
    contentResourceOptions.additionalPromptTemplatePaths.splice(
      0,
      contentResourceOptions.additionalPromptTemplatePaths.length,
      ...(next.additionalPromptTemplatePaths ?? [])
    )
    contentResourceOptions.additionalThemePaths.splice(
      0,
      contentResourceOptions.additionalThemePaths.length,
      ...(next.additionalThemePaths ?? [])
    )
    for (const key of [
      'noSkills',
      'noPromptTemplates',
      'noThemes',
      'noContextFiles',
      'systemPrompt',
      'appendSystemPrompt',
      'skillsOverride'
    ] as const) {
      if (
        (key === 'skillsOverride' &&
          (Object.hasOwn(record, 'additionalSkillFiles') || Object.hasOwn(record, 'noSkills'))) ||
        (key !== 'skillsOverride' && Object.hasOwn(record, key))
      ) {
        contentResourceOptions[key] = next[key] as never
      }
    }
    sessionResourceOptions = {
      ...(isRecord(sessionResourceOptions) ? sessionResourceOptions : {}),
      ...record,
      cwd: settingsCwd,
      agentDir
    }
  }
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
            const selected = liveSkills.sync(merged)
            resourceSnapshot.skills = [...selected]
            runtimeSkills.splice(
              0,
              runtimeSkills.length,
              ...selected.map((skill) => ({ ...skill, hide: true }))
            )
            return {
              ...resolved,
              // Keep the same mutable array in OMP so skill:// resolves after reload;
              // hide only suppresses its stale startup rendering.
              skills: runtimeSkills
            }
          },
          agentsFilesOverride: (base) => {
            const snapshot = resourceSnapshot.contextFiles
              ? { agentsFiles: resourceSnapshot.contextFiles.map((file) => ({ ...file })) }
              : base
            return resourceSnapshot.personaMarkdown
              ? filterPersonaContextFile(snapshot, join(agentDir, 'AGENTS.md'))
              : snapshot
          },
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
    evaluate: async (...args) =>
      (await loadWorkerDecisionRuntime()).evaluateDecisionRequest(...args)
  })
  const agentRunners = new Map<string, AgentRunFn>()
  const inactiveAgents = new Set<string>()
  const runnerFor = (definition: PhiAgentDefinition): AgentRunFn => {
    const existing = agentRunners.get(definition.name)
    if (existing) return existing
    const implementation = createAgentRunner({
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
          ...(environmentBinding ? { parentEnvironmentBinding: environmentBinding } : {}),
          ...(skillTools ? { skillTools } : {}),
          parent: () => parentRef.current
        })
    })
    const runner: AgentRunFn = (request) => {
      if (inactiveAgents.has(definition.name)) {
        return Promise.reject(
          new Error(`Agent ${definition.name} changed and requires a session refresh.`)
        )
      }
      return implementation(request)
    }
    agentRunners.set(definition.name, runner)
    return runner
  }
  for (const definition of phiAgents) runnerFor(definition)
  const agentTools = buildSessionAgentDelegationTools({
    definitions: phiAgents,
    runnerFor,
    registry: agentRuns,
    toolOptions: { cwd, assessTask: decide }
  })
  // A background run outlives the tool call that started it, so its end is reported to the
  // main process, which owns the conversation: it notes it in the timeline and can wake the
  // main agent. A run whose report the agent already collected is reported as such, so it
  // is not announced a second time. Foreground runs are never announced: the agent waited.
  const stopAgentRunNotices = subscribeToAgentRunNotices({
    registry: agentRuns,
    sessionId,
    requestHost
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
  const memoryTools =
    memoryPolicy.learn && memoryTarget
      ? [
          (await import('../../memory/project-memory-worker')).buildWorkerProjectLearnTool(
            memoryTarget
          )
        ]
      : []
  const customTools = [
    buildDecisionTool(decide),
    ...agentTools,
    buildPresentFilesTool(
      sessionId,
      (request) =>
        requestHost('deliverables.present', request) as Promise<{ files: PresentedFile[] }>
    ),
    buildRenderBlocksTool(),
    ...memoryTools,
    buildProjectDownloadTool(cwd, agentDir),
    ...notebookCustomTools,
    ...libraryCustomTools,
    buildPaletteRecommendationTool(),
    ...userInteractionCustomTools,
    buildEnvRequestTool(
      requestHost,
      environmentBinding
        ? { runtimeSessionId: sessionId, binding: environmentBinding, agent: 'Main' }
        : { runtimeSessionId: sessionId, requireEnvironment: true }
    ),
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
              const hadDelegationTools = phiAgents.some(supportsDelegationTool)
              for (const definition of discovered) runnerFor(definition)
              const discoveredAgentTools = buildSessionAgentDelegationTools({
                definitions: discovered,
                runnerFor,
                registry: agentRuns,
                toolOptions: { cwd, assessTask: decide },
                includeRunTools: !hadDelegationTools
              })
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
                ...discoveredAgentTools
              ]
              const added = new Set(await capabilityRegistrar.register(tools, signal))
              customTools.push(...tools.filter((tool) => added.has(tool.name)))
              const accepted = discovered.filter(
                (agent) => agent.invocation === 'host' || added.has(agent.name)
              )
              for (const agent of discovered) {
                if (!accepted.includes(agent)) agentRunners.delete(agent.name)
              }
              phiAgents.push(...accepted)
              onAgentsChanged?.()
            },
            refreshConnector: async (name) => {
              const entry = sessions.get(sessionId)
              if (!entry || entry.disposing) throw new Error('当前任务已关闭，无法加载新连接器')
              const { applyConnectorEnabledForSession } = await loadWorkerMcpRuntime()
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

  const reloadAgents = async (
    definitions: PhiAgentDefinition[]
  ): Promise<
    | { applied: true; added: string[] }
    | { applied: false; reason: 'requires_session_refresh'; changed: string[] }
  > => {
    if (inactiveAgents.size > 0) {
      return {
        applied: false,
        reason: 'requires_session_refresh',
        changed: [...inactiveAgents].sort()
      }
    }
    const current = new Map(phiAgents.map((definition) => [definition.name, definition]))
    const next = new Map(definitions.map((definition) => [definition.name, definition]))
    const changed = [
      ...phiAgents.flatMap((definition) => {
        const candidate = next.get(definition.name)
        return !candidate || JSON.stringify(candidate) !== JSON.stringify(definition)
          ? [definition.name]
          : []
      })
    ]
    if (changed.length > 0) {
      for (const name of changed) {
        inactiveAgents.add(name)
        agentRunners.delete(name)
      }
      return {
        applied: false,
        reason: 'requires_session_refresh',
        changed: [...new Set(changed)].sort()
      }
    }

    const additions = definitions.filter((definition) => !current.has(definition.name))
    if (additions.length === 0) return { applied: true, added: [] }
    const session = parentRef.current?.session
    const existing = new Set(session?.getAllToolInfos().map((tool) => tool.name) ?? [])
    const conflicts = additions
      .filter(supportsDelegationTool)
      .map((definition) => definition.name)
      .filter((name) => existing.has(name))
    if (conflicts.length > 0) {
      return {
        applied: false,
        reason: 'requires_session_refresh',
        changed: [...new Set(conflicts)].sort()
      }
    }

    for (const definition of additions) runnerFor(definition)
    const addedTools = buildSessionAgentDelegationTools({
      definitions: additions,
      runnerFor,
      registry: agentRuns,
      toolOptions: { cwd, assessTask: decide },
      includeRunTools: !phiAgents.some(supportsDelegationTool)
    })
    const registered = new Set(await capabilityRegistrar.register(addedTools))
    const accepted = additions.filter(
      (definition) => definition.invocation === 'host' || registered.has(definition.name)
    )
    const rejected = additions.filter((definition) => !accepted.includes(definition))
    if (rejected.length > 0) {
      for (const definition of additions) {
        inactiveAgents.add(definition.name)
        agentRunners.delete(definition.name)
      }
      return {
        applied: false,
        reason: 'requires_session_refresh',
        changed: rejected.map((definition) => definition.name).sort()
      }
    }
    customTools.push(...addedTools)
    phiAgents.push(...accepted)
    onAgentsChanged?.()
    return { applied: true, added: accepted.map((definition) => definition.name).sort() }
  }

  return {
    resources,
    customTools,
    agentRunners,
    stopAgentRunNotices,
    reloadAgents,
    applyResourceReload
  }
}
