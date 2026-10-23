import { relative, sep } from 'node:path'

import type {
  InlineExtension,
  ModelRuntime,
  RuntimeModel,
  RuntimeSessionManager,
  Skill as RuntimeSkill
} from '../agent/runtime/runtime-adapter'
import {
  resolveSessionCreationModel,
  type SessionCreationModelResolution
} from '../agent/session/session-creation-model'
import {
  type SessionCreationOptions,
  type SessionCreationOptionsInput
} from '../agent/session/session-creation-options'
import {
  resolveSessionCreationOwnership,
  SessionCreationContext
} from '../agent/session/session-creation-context'
import {
  type SessionCreationResourceLookup,
  type SessionCreationResources
} from '../agent/session/session-creation-resources'
import type { SessionSnapshot } from '../agent/session/session-lifecycle'
import { StaleSessionError } from '../agent/session/session-lifecycle'
import type { RemoteProjectSkillCatalog } from '../agent/content/remote-project-skill-service'
import type { RemoteProjectMcpCatalog } from '../agent/mcp/remote-project-mcp-service'
import type { PhiAgentDiscoveryResult } from '../agent/agents/discovery'
import type {
  AgentSessionCreation,
  AgentSessionCreationDeps,
  AgentSessionCreationRequest,
  AgentSessionCreationServices,
  BeginSessionCreationInput,
  CreationPromptRun,
  CreationResult,
  CreationSession,
  SessionCreationModelPhase,
  SessionCreationRuntime
} from './agent-session-creation-contracts'
import { createDefaultAgentSessionCreationServices } from './agent-session-creation-contracts'

export type { AgentSessionCreationDeps } from './agent-session-creation-contracts'

class AgentSessionCreationService<
  TPromptRun extends CreationPromptRun,
  TResult extends CreationResult<TSession>,
  TSession extends CreationSession = TResult['session']
> {
  private readonly services: AgentSessionCreationServices

  constructor(private readonly deps: AgentSessionCreationDeps<TPromptRun, TResult, TSession>) {
    this.services = this.deps.services ?? createDefaultAgentSessionCreationServices()
  }

  private readonly createSessionCreationContext = (
    input: BeginSessionCreationInput<TResult>
  ): SessionCreationContext => {
    const ownership = resolveSessionCreationOwnership(
      {
        sessionKey: input.sessionKey,
        snapshot: input.snapshot,
        generation: input.generation,
        lifecycle: input.lifecycle,
        control: input.control,
        agentDir: this.deps.workspace.agentDir
      },
      this.deps.context
    )
    return new SessionCreationContext({
      ...input,
      ...ownership,
      dependencies: this.deps.context
    })
  }

  private readonly resolveSessionCreationRoute = (context: SessionCreationContext): boolean => {
    return context.remoteProject !== null
  }

  private readonly recordSessionCreationModelMigration = (
    context: SessionCreationContext,
    resolvedModel: SessionCreationModelResolution['resolvedModel']
  ): void => {
    if (!resolvedModel?.migratedFrom) return
    this.deps.state.modelSelections.set(
      this.deps.state.sessionKeys.canonicalize(context.sessionKey),
      resolvedModel.selection
    )
    const run = this.deps.state.promptRuns.activeRun(context.sessionKey)
    const phiSessionId =
      run?.phiSessionId ?? this.deps.state.sessionKeys.phiSessionIdFor(context.sessionKey)
    if (!phiSessionId) return
    const stored = this.deps.sessions.appendEvent(phiSessionId, {
      type: 'model_selection_migrated',
      ...(run ? { runId: run.runId } : {}),
      fromProviderId: resolvedModel.migratedFrom.providerId,
      fromModelId: resolvedModel.migratedFrom.modelId,
      toProviderId: resolvedModel.selection.providerId,
      toModelId: resolvedModel.selection.modelId,
      toModelName: resolvedModel.model.name
    })
    this.deps.sessions.updateManifest(phiSessionId, { model: resolvedModel.selection })
    this.deps.events.publish({
      ...stored,
      phiSessionId,
      sessionGeneration: context.generation,
      sessionPath: this.deps.sessions.uiSessionPathForKey(
        context.sessionKey,
        context.snapshot.path
      ),
      cwd: context.snapshot.cwd
    })
  }

  private readonly prepareSessionCreationRuntime = (
    context: SessionCreationContext,
    useRpc: boolean,
    model: RuntimeModel | undefined
  ): SessionCreationRuntime => {
    const desiredThinking = this.deps.sessions.resolution.resolveSessionThinkingLevel(
      context.sessionKey,
      context.snapshot
    )
    const thinkingLevel =
      useRpc && model
        ? this.deps.runtime.selectionThinking(model, desiredThinking).phi
        : desiredThinking
    const abortController = new AbortController()
    this.deps.state.lifecycles.installAbortController(
      this.deps.cleanup.getSessionControllerKey(context.snapshot, context.generation),
      abortController
    )
    return { thinkingLevel, abortController }
  }

  private readonly prepareSessionCreationModelPhase = (
    context: SessionCreationContext,
    useRpc: boolean,
    modelRuntime: ModelRuntime
  ): SessionCreationModelPhase => {
    const modelSelection =
      context.remoteRecovery?.replacementModel ??
      this.deps.sessions.resolution.resolveSessionModelSelection(
        context.sessionKey,
        context.snapshot
      )
    const resolution = resolveSessionCreationModel(
      {
        useRpc,
        remoteRecovery: Boolean(context.remoteRecovery),
        hasRuntimeRef: Boolean(context.sessionManifest?.runtimeRef),
        modelRuntime,
        modelSelection
      },
      { resolve: this.deps.runtime.resolveRuntimeModelSelection }
    )
    this.recordSessionCreationModelMigration(context, resolution.resolvedModel)
    return {
      resolution,
      runtime: this.prepareSessionCreationRuntime(context, useRpc, resolution.model)
    }
  }

  private readonly notebookAgentRuntimePrompt = (projectCwd: string): string | null => {
    const project = this.deps.resources.notebook.getProjectByCwd(projectCwd)
    if (!project) return null

    const status = this.deps.resources.notebook.status(project.workingDirectory)
    const activeNotebookPath = this.deps.resources.notebook.activePath(project.workingDirectory)
    const registry = this.deps.resources.notebook.list(project.workingDirectory, {
      maxDepth: 4,
      maxEntries: 600,
      maxNotebooks: 12
    })
    const notebooks = registry.notebooks
      .map((notebook) => {
        const marker = notebook.path === activeNotebookPath ? ' (active)' : ''
        return `- ${notebook.relativePath}${marker}`
      })
      .join('\n')

    return [
      '<phi_notebook_runtime>',
      'This Phi project can operate .ipynb notebooks through the built-in notebook_* tools.',
      'When the user asks to read, edit, save, or run a notebook, use notebook_list, notebook_read, notebook_insert_cell, notebook_update_cell, notebook_delete_cell, notebook_run_cell, and notebook_save instead of shell-editing the .ipynb JSON by default.',
      'Notebook execution must use the Phi app-managed Jupyter Server registered for this project. Do not assume, probe, or instruct the user to restart JupyterLab on localhost:8888.',
      `Project: ${project.name ?? project.workingDirectory}`,
      `Project cwd: ${project.workingDirectory}`,
      activeNotebookPath
        ? `Active notebook: ${relative(project.workingDirectory, activeNotebookPath).split(sep).join('/')}`
        : 'Active notebook: none selected',
      `Jupyter server: ${status.state}${status.hasEndpoint ? `, app-managed port ${status.port ?? 'unknown'}` : ', no endpoint yet; notebook_run_cell may start or attach it'}`,
      registry.notebooks.length > 0
        ? `Project notebooks:\n${notebooks}`
        : 'Project notebooks: none found',
      registry.truncated
        ? 'Project notebooks list is truncated; call notebook_list for the full tool view.'
        : '',
      'If notebook_run_cell returns an error, report that tool error directly and do not invent an external JupyterLab port workaround.',
      '</phi_notebook_runtime>'
    ]
      .filter(Boolean)
      .join('\n')
  }

  private readonly remoteRuntimeSkillDefinitions = (
    catalog: RemoteProjectSkillCatalog
  ): RuntimeSkill[] =>
    catalog.sources.flatMap((source) => {
      const entry = catalog.summaries.find(
        (candidate) =>
          candidate.relativePath === source.filePath && candidate.trustState === 'trusted'
      )
      const discovered = catalog.entries.find(
        (candidate) => candidate.relativePath === source.filePath
      )
      if (!entry?.relativePath || !entry.contentHash) return []
      return [
        {
          name: entry.name,
          description: entry.description,
          filePath: entry.filePath,
          ...(discovered?.disableModelInvocation ? { disableModelInvocation: true } : {}),
          sourceInfo: {
            source: 'server-project',
            scope: 'project',
            origin: 'server-project',
            path: entry.relativePath,
            baseDir: entry.filePath.slice(0, -'/SKILL.md'.length)
          },
          remoteProject: {
            relativePath: entry.relativePath,
            contentHash: entry.contentHash
          }
        }
      ]
    })

  private readonly sessionCreationExtensionFactories = (
    context: SessionCreationContext,
    useRpc: boolean,
    abortController: AbortController
  ): InlineExtension[] =>
    this.deps.resources.createApprovalExtensions(
      {
        useRpc,
        signal: abortController.signal,
        sessionKey: context.sessionKey,
        snapshot: context.snapshot,
        generation: context.generation,
        sessionManifestId: context.sessionManifest?.sessionId,
        project: context.project
      },
      this.deps.resources.approvalDependencies
    )

  private readonly assembleSessionCreationResourcePhase = (input: {
    context: SessionCreationContext
    useRpc: boolean
    creationRuntime: SessionCreationRuntime
    notebookPrompt: string | null
    agentScan: PhiAgentDiscoveryResult
    remoteSkillCatalog: RemoteProjectSkillCatalog | undefined
    remoteContextFiles: SessionCreationResources['remoteContextFiles']
    remoteMcpCatalog: RemoteProjectMcpCatalog | undefined
  }): SessionCreationResources => {
    const { context } = input
    return this.services.assembleResources({
      useRpc: input.useRpc,
      remoteProject: context.remoteProject !== null,
      cwd: context.snapshot.cwd,
      agentDir: this.deps.workspace.agentDir,
      notebookPrompt: input.notebookPrompt,
      agentScan: input.agentScan,
      remoteSkillCatalog: input.remoteSkillCatalog,
      remoteMcpCatalog: input.remoteMcpCatalog,
      remoteContextFiles: input.remoteContextFiles,
      personaMarkdown: this.deps.workspace.getPersonaMarkdown(),
      extensionFactories: () =>
        this.sessionCreationExtensionFactories(
          context,
          input.useRpc,
          input.creationRuntime.abortController
        ),
      onDiagnostic: (diagnostic) =>
        this.deps.resources.writeAppLog(this.services.diagnosticLog(diagnostic)),
      remoteProjectSkills: this.remoteRuntimeSkillDefinitions
    })
  }

  private readonly prebindRemoteSessionCreation = (
    context: SessionCreationContext,
    useRpc: boolean,
    model: RuntimeModel | undefined,
    thinkingLevel: SessionCreationOptionsInput['thinkingLevel']
  ): void => {
    if (!useRpc || !context.sessionManifest || context.sessionManifest.runtimeRef || !model) return
    const latest = this.deps.sessions.findById(context.sessionManifest.sessionId)
    if (
      !latest ||
      latest.runtimeRef ||
      JSON.stringify(latest.model) !== JSON.stringify(context.sessionManifest.model) ||
      latest.thinkingLevel !== context.sessionManifest.thinkingLevel
    ) {
      throw new StaleSessionError()
    }
    if (latest.thinkingLevel !== thinkingLevel) {
      this.deps.sessions.updateManifest(context.sessionManifest.sessionId, { thinkingLevel })
    }
  }

  private readonly sessionCreationManager = (
    context: SessionCreationContext,
    useRpc: boolean
  ): RuntimeSessionManager =>
    useRpc
      ? this.deps.runtime.createRemoteSessionManager(
          context.snapshot.cwd,
          context.sessionManifest!.sessionId,
          Boolean(context.sessionManifest?.runtimeRef)
        )
      : this.deps.runtime.createSessionManager(
          context.snapshot.cwd,
          this.deps.sessions.runtimeSessionPathForSnapshot(context.sessionKey, context.snapshot)
        )

  private readonly prepareSessionCreationOptions = (
    context: SessionCreationContext,
    useRpc: boolean,
    modelPhase: SessionCreationModelPhase,
    resources: SessionCreationResources
  ): SessionCreationOptions => {
    this.prebindRemoteSessionCreation(
      context,
      useRpc,
      modelPhase.resolution.model,
      modelPhase.runtime.thinkingLevel
    )
    return this.services.buildOptions({
      remoteRecovery: context.remoteRecovery,
      modelRuntime: modelPhase.resolution.modelRuntime,
      model: modelPhase.resolution.model,
      thinkingLevel: modelPhase.runtime.thinkingLevel,
      autoCompaction: context.sessionManifest?.autoCompaction,
      cwd: context.snapshot.cwd,
      sessionManager: this.sessionCreationManager(context, useRpc),
      resourceLoader: resources.resourceLoader,
      phiAgents: resources.agentScan.agents,
      remoteProjectMcpServers: useRpc ? undefined : resources.remoteMcpCatalog?.runtimeServers,
      projectBound: Boolean(context.project),
      memory: context.project?.memory,
      remoteRuntimeRoot:
        context.remoteProject && context.project
          ? this.deps.runtime.projectRemoteRuntimeRoot(context.project)
          : undefined,
      remoteProject: context.remoteProject,
      phiSessionId: context.sessionManifest?.sessionId ?? '',
      remoteContextFiles: resources.remoteContextFiles ?? [],
      personaMarkdown: resources.personaMarkdown
    })
  }

  private readonly registerCreatedSessionOrigin = (
    context: SessionCreationContext,
    result: TResult
  ): void => {
    context.assertCurrent(true)
    const phiSessionId =
      context.sessionManifest?.sessionId ??
      this.deps.state.sessionKeys.phiSessionIdFor(context.sessionKey)
    const confirmed = phiSessionId ? this.deps.sessions.findById(phiSessionId) : null
    if (
      !confirmed ||
      (confirmed.projectLocation?.kind === 'ssh' &&
        !this.deps.runtime.ownsRemoteRuntimeSession(result.session.runtimeSessionId))
    ) {
      return
    }
    const remoteScope =
      confirmed.projectLocation?.kind === 'ssh'
        ? this.deps.sessions.origins.currentRuntimeOriginScope(confirmed)
        : undefined
    if (confirmed.projectLocation?.kind === 'ssh' && !remoteScope) {
      throw new Error('远程运行来源尚未验证')
    }
    this.deps.linking.recordRuntimeOrigin(
      {
        runtimeSessionId: result.session.runtimeSessionId,
        phiSessionId: confirmed.sessionId,
        projectId: confirmed.projectId ?? null,
        cwd: confirmed.cwd,
        ...(remoteScope
          ? {
              remoteScope,
              configuredRuntimeRoot: this.deps.runtime.projectRemoteRuntimeRoot(
                this.deps.runtime.requireProject(confirmed.projectId!)
              ).configured
            }
          : {})
      },
      this.deps.workspace.agentDir
    )
  }

  private readonly linkCreatedSession = (
    context: SessionCreationContext,
    result: TResult
  ): void => {
    if (typeof result.session.runtimeSessionId === 'string') {
      this.deps.state.sessionKeys.recordOrigin(result.session.runtimeSessionId, {
        sessionKey: context.sessionKey,
        cwd: context.snapshot.cwd
      })
    }
    const run = this.deps.state.promptRuns.activeRun(context.sessionKey)
    if (run) {
      this.deps.sessions.linkPromptRunRuntimeSessionPath(
        context.sessionKey,
        context.snapshot.cwd,
        run,
        result.session
      )
    } else {
      this.deps.sessions.linkMaterializedRuntimeSessionPath(
        context.sessionKey,
        context.snapshot.cwd,
        result.session.sessionFile
      )
    }
    this.deps.state.sessionState.updateCreatedSessionPath(
      context.sessionKey,
      context.generation,
      context.snapshot.path,
      {
        isCurrentGeneration: (candidateGeneration) =>
          context.lifecycle.isCurrentGeneration(candidateGeneration),
        sameCanonicalSessionKey: this.deps.state.sessionKeys.sameCanonical.bind(
          this.deps.state.sessionKeys
        ),
        uiSessionPathForKey: this.deps.sessions.uiSessionPathForKey,
        notifySessionChanged: this.deps.sessions.notifySessionChanged
      }
    )
  }

  private readonly beginAgentSessionCreation = (
    request: AgentSessionCreationRequest<TResult>,
    snapshot: SessionSnapshot,
    generation: number
  ): SessionCreationContext =>
    this.createSessionCreationContext({
      sessionKey: request.sessionKey,
      snapshot,
      generation,
      lifecycle: request.lifecycle,
      control: request.control,
      remoteRecovery: request.remoteRecovery
    })

  private readonly createPreparedAgentSession = (
    context: SessionCreationContext,
    useRpc: boolean,
    modelPhase: SessionCreationModelPhase,
    resources: SessionCreationResources
  ): Promise<TResult> =>
    this.deps.runtime.createAgentSession(
      this.prepareSessionCreationOptions(context, useRpc, modelPhase, resources),
      undefined,
      context.control
    )

  private readonly coordinateAgentSessionCreation = async (
    request: AgentSessionCreationRequest<TResult>,
    creationSnapshot: SessionSnapshot,
    generation: number
  ): Promise<TResult> => {
    const context = this.beginAgentSessionCreation(request, creationSnapshot, generation)
    context.assertCurrent()
    await this.deps.state.lifecycles.waitForCleanup(context.snapshot)
    context.assertCurrent()
    const useRpc = this.resolveSessionCreationRoute(context)
    const remoteContextFiles = context.remoteProject
      ? await this.deps.runtime.loadRemoteProjectInstructions(context.remoteProject.location)
      : null
    context.assertCurrent()
    const modelRuntime = await this.deps.runtime.getModelRuntime()
    context.assertCurrent()
    const modelPhase = this.prepareSessionCreationModelPhase(context, useRpc, modelRuntime)
    const notebookPrompt = context.remoteProject
      ? null
      : this.notebookAgentRuntimePrompt(context.snapshot.cwd)
    const resourceLookup: SessionCreationResourceLookup = this.services.createResourceLookup(
      context.sessionManifest?.sessionId,
      context.remoteProject?.projectId,
      context.snapshot.cwd,
      this.deps.workspace.agentDir
    )
    const agentScan = useRpc
      ? this.services.emptyAgentScan()
      : context.remoteProject
        ? await this.services.loadRemoteAgents(
            resourceLookup,
            this.deps.workspace.getBundledAgentsDir
          )
        : this.services.discoverLocalAgents(resourceLookup, this.deps.workspace.getBundledAgentsDir)
    context.assertCurrent()
    const remoteSkillCatalog = context.remoteProject
      ? await this.services.loadRemoteSkills(resourceLookup)
      : undefined
    context.assertCurrent()
    const remoteMcpCatalog = context.remoteProject
      ? await this.services.loadRemoteMcp(resourceLookup)
      : undefined
    context.assertCurrent()
    const resources = this.assembleSessionCreationResourcePhase({
      context,
      useRpc,
      creationRuntime: modelPhase.runtime,
      notebookPrompt,
      agentScan,
      remoteSkillCatalog,
      remoteContextFiles,
      remoteMcpCatalog
    })
    if (resources.resourceLoader) await resources.resourceLoader.reload()
    context.assertCurrent()
    const result = await this.createPreparedAgentSession(context, useRpc, modelPhase, resources)
    try {
      this.registerCreatedSessionOrigin(context, result)
    } catch (error) {
      try {
        await this.deps.cleanup.abortSessionWithoutCancellingApprovals(result.session)
      } catch (cleanupError) {
        this.deps.cleanup.logUnexpectedError(cleanupError)
      }
      try {
        await result.session.dispose()
      } catch (cleanupError) {
        this.deps.cleanup.logUnexpectedError(cleanupError)
      }
      throw error
    }
    this.linkCreatedSession(context, result)
    this.deps.events.subscribeToCreatedSession(context, result)
    return result
  }

  readonly getAgentSession: AgentSessionCreation<TResult>['getAgentSession'] = async (
    sessionKey = this.deps.state.sessionState.sessionKey,
    snapshot = {
      path: this.deps.state.sessionState.sessionPath,
      cwd: this.deps.state.sessionState.cwd,
      permissionMode: this.deps.state.sessionState.permissionMode
    },
    control,
    remoteRecovery
  ) => {
    const lifecycle = this.deps.state.lifecycles.forKey(sessionKey)
    const creationRequest = { sessionKey, lifecycle, control, remoteRecovery }
    const record = lifecycle.getOrCreate(
      snapshot,
      (creationSnapshot, generation) =>
        this.coordinateAgentSessionCreation(creationRequest, creationSnapshot, generation),
      async ({ session }) => {
        await this.deps.cleanup.abortAndDisposeSession(session, { cancelApprovals: false })
      }
    )

    return record.promise
  }
}

export function createAgentSessionCreation<
  TPromptRun extends CreationPromptRun,
  TResult extends CreationResult<TSession>,
  TSession extends CreationSession = TResult['session']
>(deps: AgentSessionCreationDeps<TPromptRun, TResult, TSession>): AgentSessionCreation<TResult> {
  const service = new AgentSessionCreationService(deps)
  return { getAgentSession: service.getAgentSession }
}
