import { createHash, randomUUID } from 'node:crypto'
import { createFacadeDesktopToolScopeFactory } from './facade-desktop-tool-scope'
import {
  compactionPolicy,
  type RpcCompactionPolicy
} from '../phi-extension/lib/rpc-compaction-control'
import type {
  AutoCompactionOverrides,
  ContextCompactionSummary
} from '../../../../shared/contextUsageTypes'
import { BrowserTextVault } from '../../browser/browser-text-vault'
import { assertSafeBrowserHistory } from './browser-tool-stream'
import { selectionThinking, type RuntimeInitialSelection } from './runtime-selection-control'
import { getPhiAgentDir } from '../../runtime-paths'
import {
  resolveRemoteWorkspaceHostBinding,
  type RemoteWorkspaceHostBinding
} from '../../remote-workspace-boundary'
import {
  beginRuntimeReferenceAdoption,
  updateSessionManifest,
  findPhiSessionById
} from '../../session/session-store'
import type { RuntimeReferenceAdoption } from '../../session/runtime-reference-adoption'
import {
  assertRuntimeScope,
  parseRuntimeReference,
  RuntimeReferenceError
} from '../../session/runtime-reference'
import { phiOnlySessionPath } from '../../session/sessions'
import type { SessionRunnerRegistry, SessionRun } from '../../session/session-runner-registry'
import type { OmpBridge } from '../omp-bridge'
import type {
  PhiSessionCreateParams,
  RuntimeModel,
  WorkerSessionState,
  RuntimeSelectionControl,
  ThinkingLevel
} from '../types'
import type { ResolvedRuntimeCompactionPolicy } from '../types'
import {
  RemoteSessionCapabilityError,
  type RoutedSessionDriver,
  type RoutedSessionFactory
} from '../session-routing-engine'
import type { RpcDesktopToolScope, RpcDesktopToolScopeOptions } from './desktop-tool-scope'
import {
  RemoteSessionRuntime,
  type RemoteRuntimeSnapshot,
  type RemoteSessionRuntimeOptions
} from './remote-session-runtime'
import { prepareRemoteSessionStorage } from './session-storage/writer-lease'
import type { RemoteSessionScope } from './session-storage/types'
import { canonicalRemoteSessionName, RemoteMetadataBusyError } from './runtime-metadata-control'
import { RpcFacadeEventProjector } from './facade-event-projection'
import type { RpcPromptOptions } from './types'
import type { RpcApprovalEvent } from './approval-bridge'
import { createFacadeChildApprovalWriter } from './facade-child-approval'
import type { PhiAgentDefinition, PhiAgentThinkingLevel } from '../../agents/definition'
import { deriveProductionChildBinding } from './subagents/production-child-config'
import type { FacadePromptContext } from '../phi-extension/lib/rpc-prompt-policy'
import { rpcPromptPolicy } from '../phi-extension/lib/rpc-prompt-policy'
import { join } from 'node:path'
import { filterPersonaContextFile } from '../phi-extension/lib/phi-main-system-prompt'
import type { DesktopProjectMemoryAdapter } from './desktop-project-memory-adapter'
import { RemoteRecoveryError } from './session-recovery'
import type {
  CompileRpcAgentDefinitionsOptions,
  RpcAgentResourceCatalogInput,
  RpcChildRunSnapshot
} from './subagents/types'
import { resolveRpcAgentModelRefs } from './subagents/definition-compiler'
import { FacadeChildToolScopes, childJobView } from './facade-child-tool-scopes'
import { recordChildRunRecovery } from '../../session/child-run-recovery'
import { AGENT_RUN_HOST_METHODS } from '../../agents/run-host'
import { createFacadeAgentRunTools } from './facade-agent-run-tools'
import type { RemoteStartupDiagnostics } from './remote-startup-diagnostics'
import { remoteTurnFailure } from './turn-failure'
export type { FacadePromptContext } from '../phi-extension/lib/rpc-prompt-policy'

export interface SelectedFacadeRuntime {
  readonly onMemoryError?: () => void | Promise<void>
  readonly memory?: DesktopProjectMemoryAdapter
  readonly promptContext?: FacadePromptContext
  readonly hostProfileId: string
  /** Exact selected project/profile binding, never host-alias-only identity. */
  readonly bindingHash: string
  readonly projectId: string
  readonly projectRoot: string
  readonly runtime: RemoteSessionRuntimeOptions['transport']['runtime']
  readonly session: RemoteSessionRuntimeOptions['transport']['session']
  readonly bundle: RemoteSessionRuntimeOptions['transport']['bundle']
  readonly recovery: 'new' | 'resume'
  readonly startupDiagnostics?: RemoteStartupDiagnostics
  readonly onRunTakeover?: RemoteSessionRuntimeOptions['transport']['onRunTakeover']
  readonly approval: RemoteSessionRuntimeOptions['approval']
  /** Explicit curated desktop tools; unready browser/privacy/child adapters cannot be enabled. */
  readonly desktopToolNames: readonly string[]
  readonly desktopTools?: Pick<
    RpcDesktopToolScopeOptions,
    | 'allowedSkills'
    | 'scriptTools'
    | 'skillCatalog'
    | 'assertBinding'
    | 'scriptApprovalFor'
    | 'paletteCatalogPath'
    | 'remoteLibrary'
    | 'desktopWebSearch'
    | 'desktopMcp'
  >
  readonly recentUserImages: RpcDesktopToolScopeOptions['recentUserImages']
  readonly nativeTools?: RemoteSessionRuntimeOptions['nativeTools']
  /** Trusted main-process snapshot; renderer phiAgents never activates this capability. */
  readonly foregroundChildren?: {
    readonly definitions: readonly PhiAgentDefinition[]
    readonly allowParallel?: boolean
    readonly allowBackground?: boolean
    readonly resources?: Pick<RpcAgentResourceCatalogInput, 'skills'>
    readonly resolveEnvironment?: CompileRpcAgentDefinitionsOptions['resolveEnvironment']
    readonly onChildChange?: (snapshot: Readonly<RpcChildRunSnapshot>, parent: SessionRun) => void
    /** Notification only; the facade is the single durable approval writer. */
    readonly onApprovalEvent?: (event: RpcApprovalEvent, parent: SessionRun) => void | Promise<void>
  }
  readonly onInterrupted?: (error: Error) => void
  /** Application-owned SSH/runtime workspace, released after its last runtime channel. */
  readonly dispose?: () => void | Promise<void>
}
export interface FacadeSessionFactoryOptions {
  readonly compactionPolicy?: (
    agentDir: string,
    overrides: AutoCompactionOverrides
  ) => Promise<ResolvedRuntimeCompactionPolicy>
  /** The real singleton whose host registry is populated by engine.host.register. */
  readonly bridge: OmpBridge
  readonly models: (agentDir: string) => Promise<readonly RuntimeModel[]>
  /** Actual application SessionRunnerRegistry, not a run identifier from prompt options. */
  readonly runners: SessionRunnerRegistry
  /** Main-only selection; async preparation is rechecked before any runtime or adoption. */
  readonly selected: (
    identity: {
      runtimeSessionId: string
      phiSessionId: string
      projectId: string
    },
    signal: AbortSignal
  ) => SelectedFacadeRuntime | Promise<SelectedFacadeRuntime>
}
export function facadeBindingHash(binding: RemoteWorkspaceHostBinding): string {
  return createHash('sha256').update(binding.cacheKey).digest('hex')
}

function captureSelection(selected: SelectedFacadeRuntime): SelectedFacadeRuntime {
  const session = selected.session
  return Object.freeze({
    ...selected,
    promptContext: selected.promptContext && Object.freeze(structuredClone(selected.promptContext)),
    runtime: Object.freeze({ ...selected.runtime }),
    session: Object.freeze({
      openStdio: session.openStdio?.bind(session),
      openReverseTunnel: session.openReverseTunnel?.bind(session),
      execWithInput: session.execWithInput?.bind(session),
      execBounded: session.execBounded?.bind(session)
    }),
    approval: Object.freeze({ ...selected.approval }),
    desktopToolNames: Object.freeze([...selected.desktopToolNames]),
    nativeTools: selected.nativeTools && Object.freeze([...selected.nativeTools]),
    foregroundChildren:
      selected.foregroundChildren &&
      Object.freeze({
        ...selected.foregroundChildren,
        definitions: Object.freeze(structuredClone(selected.foregroundChildren.definitions))
      }),
    desktopTools:
      selected.desktopTools &&
      Object.freeze({
        ...selected.desktopTools,
        allowedSkills: Object.freeze([...selected.desktopTools.allowedSkills]),
        skillCatalog:
          selected.desktopTools.skillCatalog &&
          Object.freeze(structuredClone(selected.desktopTools.skillCatalog)),
        scriptTools: Object.freeze(structuredClone(selected.desktopTools.scriptTools))
      })
  })
}

function promptOptions(raw: Record<string, unknown> | undefined): RpcPromptOptions | undefined {
  if (!raw) return undefined
  // hostRunId is compatibility data only; the real registry supplies authority.
  if (Object.keys(raw).some((key) => !['images', 'hostRunId'].includes(key)))
    throw new RemoteSessionCapabilityError('prompt options')
  if (raw.images === undefined) return undefined
  if (
    !Array.isArray(raw.images) ||
    raw.images.some(
      (part) =>
        !part ||
        typeof part !== 'object' ||
        part.type !== 'image' ||
        typeof part.data !== 'string' ||
        typeof part.mimeType !== 'string'
    )
  )
    throw new Error('Invalid remote prompt images')
  return {
    images: raw.images.map((part) => ({ type: 'image', data: part.data, mimeType: part.mimeType }))
  }
}
function childThinkingLevel(
  level: PhiSessionCreateParams['thinkingLevel'],
  reasoning: RuntimeModel['reasoning']
): PhiAgentThinkingLevel {
  if (reasoning === false) return 'off'
  if (level === 'max') throw new RemoteSessionCapabilityError('foreground child thinking level')
  return level ?? 'off'
}
function capabilityGuard(params: PhiSessionCreateParams): void {
  if (
    params.noTools ||
    params.resourceOptions ||
    params.phiAgents?.length ||
    params.remoteProjectMcpServers?.length
  )
    throw new RemoteSessionCapabilityError(
      'resources/MCP/memory/persona/child/context configuration'
    )
  if (
    params.sessionManager.kind === 'open' &&
    params.sessionManager.path !== phiOnlySessionPath(params.remoteProject!.phiSessionId)
  )
    throw new RuntimeReferenceError('REMOTE_OPERATION_REQUIRED', '远程恢复必须使用 Phi 会话身份')
}
function workerState(
  snapshot: RemoteRuntimeSnapshot,
  anchor: string,
  phiId: string,
  models: readonly RuntimeModel[],
  projector: RpcFacadeEventProjector
): WorkerSessionState {
  assertSafeBrowserHistory(snapshot.messages)
  const model = models.find(
    (candidate) =>
      candidate.provider === snapshot.model.provider && candidate.id === snapshot.model.id
  )
  if (!model) throw new Error('Verified remote model is absent from the desktop registry')
  const level = snapshot.thinkingLevel
  if (
    level !== undefined &&
    level !== 'off' &&
    !['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(level)
  )
    throw new RemoteSessionCapabilityError('thinking level projection')
  return {
    sessionFile: phiOnlySessionPath(phiId),
    cwd: anchor,
    model: structuredClone(model),
    messages: projector.messages(snapshot.messages),
    ...(level && level !== 'off'
      ? { thinkingLevel: level as NonNullable<WorkerSessionState['thinkingLevel']> }
      : {})
  }
}

/** Real production CLI + desktop service registry + durable Phi adoption; no SDK session objects. */
export function createFacadeSessionFactory(
  options: FacadeSessionFactoryOptions
): RoutedSessionFactory {
  return {
    async create(params, signal, sink, control): Promise<RoutedSessionDriver> {
      control?.assertCurrent()
      let creationControl = control
      signal.throwIfAborted()
      if (!params.remoteProject) throw new Error('Remote facade requires an explicit SSH project')
      const requestedPrompt = structuredClone({
        personaMarkdown: params.personaMarkdown ?? '',
        contextFiles: params.remoteProject.contextFiles
      })
      capabilityGuard(params)
      const { phiSessionId, projectId, location } = params.remoteProject
      const binding = resolveRemoteWorkspaceHostBinding({ sessionId: phiSessionId, projectId })
      const initial = findPhiSessionById(phiSessionId)
      if (!initial) throw new Error('Phi session does not exist')
      if (
        JSON.stringify(params.autoCompaction ?? {}) !== JSON.stringify(initial.autoCompaction ?? {})
      )
        throw new RemoteSessionCapabilityError('unsaved auto compaction policy')
      const selected = captureSelection(
        await options.selected(
          {
            runtimeSessionId: params.sessionId,
            phiSessionId,
            projectId
          },
          signal
        )
      )
      let selectedCleanup: Promise<void> | undefined
      const disposeSelected = (): Promise<void> =>
        (selectedCleanup ??= Promise.resolve().then(async () => {
          let failed = false,
            failure: unknown
          try {
            await selected.memory?.close()
          } catch (error) {
            failed = true
            failure = error
          }
          try {
            await selected.dispose?.()
          } catch (error) {
            if (!failed) {
              failed = true
              failure = error
            }
          }
          if (failed) throw failure
        }))
      try {
        signal.throwIfAborted()
        if (params.memory?.enabled && !selected.memory)
          throw new RemoteSessionCapabilityError('untrusted project memory')
        const promptContext = selected.promptContext ?? { contextFiles: [] }
        if (
          (promptContext.personaMarkdown ?? '') !== requestedPrompt.personaMarkdown ||
          JSON.stringify(promptContext.contextFiles.map(({ path, content }) => [path, content])) !==
            JSON.stringify(
              requestedPrompt.contextFiles.map(({ path, content }) => [path, content])
            ) ||
          (promptContext.personaPath !== undefined &&
            promptContext.personaPath !== join(params.agentDir, 'AGENTS.md'))
        )
          throw new RemoteSessionCapabilityError('untrusted persona or remote context snapshot')
        const promptPolicy = rpcPromptPolicy({
          ...promptContext,
          contextFiles: filterPersonaContextFile(
            { agentsFiles: [...promptContext.contextFiles] },
            join(params.agentDir, 'AGENTS.md')
          ).agentsFiles,
          schema: 1,
          nonce: 'preflight',
          phiSessionId,
          projectId,
          projectRoot: binding.canonicalRoot,
          contextRoot: binding.remoteRoot,
          hostAlias: binding.hostAlias,
          generation: 1
        })
        const afterSelection = findPhiSessionById(phiSessionId)
        const afterBinding = resolveRemoteWorkspaceHostBinding({
          sessionId: phiSessionId,
          projectId
        })
        if (
          !afterSelection ||
          JSON.stringify([
            afterSelection.cwd,
            afterSelection.cwdRealPath,
            afterSelection.projectLocation,
            afterSelection.model,
            afterSelection.thinkingLevel,
            afterSelection.title,
            afterSelection.runtimeRef,
            afterSelection.runtimeRecoveryError
          ]) !==
            JSON.stringify([
              initial.cwd,
              initial.cwdRealPath,
              initial.projectLocation,
              initial.model,
              initial.thinkingLevel,
              initial.title,
              initial.runtimeRef,
              initial.runtimeRecoveryError
            ]) ||
          facadeBindingHash(afterBinding) !== facadeBindingHash(binding)
        )
          throw new RuntimeReferenceError('STALE_GENERATION', '远程选择期间会话或项目策略已改变')
        const scope: RemoteSessionScope = Object.freeze({
          hostProfileId: selected.hostProfileId,
          bindingHash: facadeBindingHash(binding),
          projectId,
          projectRoot: binding.canonicalRoot,
          runtimeRoot: selected.runtime.runtimeRoot,
          phiSessionId
        })
        if (
          params.agentDir !== getPhiAgentDir() ||
          params.cwd !== initial.cwd ||
          params.sessionManager.cwd !== initial.cwd ||
          params.projectBound !== true ||
          initial.projectLocation?.kind !== 'ssh' ||
          selected.hostProfileId !== initial.projectLocation.hostProfileId ||
          selected.bindingHash !== scope.bindingHash ||
          selected.projectId !== projectId ||
          selected.projectRoot !== binding.canonicalRoot ||
          JSON.stringify(location) !== JSON.stringify(initial.projectLocation)
        )
          throw new RuntimeReferenceError(
            'HOST_IDENTITY_CHANGED',
            '所选远程运行与 Phi 项目绑定不一致'
          )
        if (initial.runtimeRecoveryError)
          throw new RuntimeReferenceError(
            initial.runtimeRecoveryError.code,
            initial.runtimeRecoveryError.message
          )
        const reference = initial.runtimeRef
          ? parseRuntimeReference(initial.runtimeRef, phiSessionId)
          : undefined
        if (reference) assertRuntimeScope(reference, scope)
        if ((reference ? 'resume' : 'new') !== selected.recovery)
          throw new RuntimeReferenceError(
            'REMOTE_OPERATION_REQUIRED',
            '必须显式选择新建或恢复远程会话'
          )
        const savedModel = initial.model && {
          provider: initial.model.providerId,
          id: initial.model.modelId
        }
        const replacement = params.remoteRecovery?.replacementModel
        if (replacement && (!reference || !replacement.providerId || !replacement.modelId))
          throw new Error('Explicit replacement requires an existing remote session')
        const chosenModel = replacement
          ? { provider: replacement.providerId, id: replacement.modelId }
          : reference
            ? savedModel
            : params.model && { provider: params.model.provider, id: params.model.id }
        if (
          !chosenModel ||
          (params.model &&
            (params.model.provider !== chosenModel.provider || params.model.id !== chosenModel.id))
        )
          throw new Error('Explicit remote model policy is required')
        if (
          !savedModel ||
          (!replacement &&
            (chosenModel.provider !== savedModel.provider || chosenModel.id !== savedModel.id)) ||
          (reference === undefined && params.thinkingLevel !== initial.thinkingLevel)
        )
          throw new Error('Phi model/thinking policy must be saved before remote creation')
        let expectedTitle = initial.title
        if (
          expectedTitle !== undefined &&
          canonicalRemoteSessionName(expectedTitle) !== expectedTitle
        )
          throw new Error('Saved Phi title requires explicit canonical policy')
        // Capture anchor/reference/generation BEFORE registry/deployment/gateway awaits.
        const generation = randomUUID()
        let adoption: RuntimeReferenceAdoption | undefined = beginRuntimeReferenceAdoption(
          phiSessionId,
          scope,
          generation,
          { signal }
        )
        const initialAdoption = adoption
        let attachedReference = reference
        let firstCheckpoint = true
        let runtime: RemoteSessionRuntime | undefined
        let detach: (() => void) | undefined
        let closing: Promise<void> | undefined
        let interrupted: Error | undefined
        let metadataPending = false
        let contextUsagePending: ReturnType<RemoteSessionRuntime['readContextUsage']> | undefined
        let selectionAbort: AbortController | undefined
        let selectionPending: Promise<WorkerSessionState> | undefined
        let compactionPending: Promise<unknown> | undefined
        let submittedRun: SessionRun | undefined
        const stopSubmittedRun = (): void => {
          const run = submittedRun
          if (run && options.runners.getActiveRun(phiSessionId) === run)
            options.runners.stopRun(phiSessionId)
        }
        const vault = new BrowserTextVault()
        let tools: RpcDesktopToolScope | undefined
        let childTools: FacadeChildToolScopes | undefined
        try {
          const createScope = createFacadeDesktopToolScopeFactory({
            identity: {
              runtimeSessionId: params.sessionId,
              sessionId: phiSessionId,
              projectId,
              cwd: binding.canonicalRoot
            },
            agentDir: params.agentDir,
            bridge: options.bridge,
            selected,
            runtime: () => runtime,
            vault
          })
          tools = createScope(() => runtime?.currentRun())
          if (selected.foregroundChildren)
            childTools = new FacadeChildToolScopes({
              definitions: selected.foregroundChildren.definitions,
              createScope,
              current: (id) => runtime?.childRunForHost(id),
              name: (run) => runtime!.childResourceOwner(run.id).toolOwner
            })
          const projector = new RpcFacadeEventProjector()
          const scopeTools = tools
          const memoryNames = selected.memory?.tools.map((tool) => tool.name) ?? []
          const names = new Set([...selected.desktopToolNames, ...memoryNames])
          if (
            names.size !== selected.desktopToolNames.length + memoryNames.length ||
            (names.has('browser') && !selected.desktopTools) ||
            [...names].some((name) => !scopeTools.tools.some((tool) => tool.name === name))
          )
            throw new RemoteSessionCapabilityError('desktop tool roster/browser privacy')
          let models = await options.models(params.agentDir)
          signal.throwIfAborted()
          const model = models.find(
            (candidate) =>
              candidate.provider === chosenModel.provider && candidate.id === chosenModel.id
          )
          if (!model)
            throw new RemoteRecoveryError(
              'MODEL_UNAVAILABLE',
              'Selected remote model is unavailable'
            )
          const stateFrom = (snapshot: RemoteRuntimeSnapshot): WorkerSessionState =>
            workerState(snapshot, initial.cwd, phiSessionId, models, projector)
          let state: WorkerSessionState | undefined
          let expectedModel = initial.model
          let expectedThinking = initial.thinkingLevel
          let expectedAuto = initial.autoCompaction ?? {}
          let currentCompaction: RpcCompactionPolicy | undefined
          let currentCompactionDefaults:
            import('../../../../shared/contextUsageTypes').AutoCompactionDefaults | undefined
          if (options.compactionPolicy) {
            const resolved = await options.compactionPolicy(params.agentDir, expectedAuto)
            currentCompaction = compactionPolicy(resolved.policy)
            currentCompactionDefaults = resolved.defaults
          }
          signal.throwIfAborted()
          let rotating = false
          let runtimeEpoch = 0
          let selectionState: WorkerSessionState | undefined
          const assertAdoptionPolicy = (): void => {
            creationControl?.assertCurrent()
            const latest = findPhiSessionById(phiSessionId)
            if (
              !latest ||
              JSON.stringify(latest.model) !== JSON.stringify(expectedModel) ||
              latest.thinkingLevel !== expectedThinking ||
              JSON.stringify(latest.autoCompaction ?? {}) !== JSON.stringify(expectedAuto)
            )
              throw new RuntimeReferenceError('STALE_GENERATION', '远程证明期间模型策略已改变')
            if (latest.title !== expectedTitle)
              throw new RuntimeReferenceError('STALE_GENERATION', '远程会话名称策略已改变')
            const latestBinding = resolveRemoteWorkspaceHostBinding({
              sessionId: phiSessionId,
              projectId
            })
            if (latest.cwd !== initial.cwd || latest.cwdRealPath !== initial.cwdRealPath)
              throw new RuntimeReferenceError('STALE_GENERATION', '远程会话锚点已改变')
            if (facadeBindingHash(latestBinding) !== scope.bindingHash)
              throw new RuntimeReferenceError('HOST_IDENTITY_CHANGED', '远程证明期间主机绑定已改变')
          }
          const startRuntime = async (
            bootModel: RuntimeModel,
            action: RemoteSessionRuntimeOptions['action'],
            selection?: RuntimeInitialSelection,
            nextCompaction = currentCompaction
          ): Promise<RemoteSessionRuntime> => {
            assertAdoptionPolicy()
            const epoch = ++runtimeEpoch
            const childModels = selected.foregroundChildren
              ? await resolveRpcAgentModelRefs(
                  selected.foregroundChildren.definitions,
                  models,
                  selection?.model ?? bootModel
                )
              : []
            assertAdoptionPolicy()
            const refs = [bootModel, ...(selection ? [selection.model] : []), ...childModels]
              .filter(
                (value, index, all) =>
                  all.findIndex(
                    (item) => item.provider === value.provider && item.id === value.id
                  ) === index
              )
              .map(({ provider, id }) => ({ provider, id }))
            const runTools = selected.foregroundChildren
              ? createFacadeAgentRunTools({
                  runtimeSessionId: params.sessionId,
                  phiSessionId,
                  projectId,
                  host: options.bridge.hostServices,
                  assertCurrent: () => {
                    assertAdoptionPolicy()
                    if (
                      !controlOwner ||
                      runtime !== controlOwner ||
                      epoch !== runtimeEpoch ||
                      closing ||
                      interrupted
                    )
                      throw new RuntimeReferenceError('STALE_GENERATION', '专家控制代次已改变')
                  },
                  list: () => controlOwner!.listChildRuns(),
                  wait: (options) => controlOwner!.waitForChildren(options),
                  steer: (id, message, signal) => controlOwner!.steerChild(id, message, signal),
                  stop: (id, signal) => controlOwner!.stopChild(id, signal),
                  readChildReport: (run, signal) => controlOwner!.readChildReport(run, signal),
                  waitCompletionDelivery: (id) => controlOwner!.awaitChildCompletionDelivery(id)
                })
              : []
            const controlOwner: RemoteSessionRuntime = await RemoteSessionRuntime.create({
              transport: {
                projectId,
                runtime: selected.runtime,
                session: selected.session,
                bundle: selected.bundle,
                ...(action.type === 'resume' ? { resumeReference: action.reference } : {}),
                startupDiagnostics: selected.startupDiagnostics,
                ...(selected.onRunTakeover ? { onRunTakeover: selected.onRunTakeover } : {}),
                gateway: options.bridge,
                models: refs,
                preparePersistentStorage: ({ signal: storageSignal }) =>
                  prepareRemoteSessionStorage({
                    runtimeHost: selected.runtime.runtimeHost,
                    scope,
                    signal: storageSignal,
                    deferToStartup: true,
                    openLockStdio: (command) => selected.session.openStdio!(command)
                  })
              },
              params: {
                sessionId: phiSessionId,
                cwd: binding.canonicalRoot,
                agentDir: params.agentDir,
                model: bootModel,
                thinkingLevel: action.type === 'new' ? params.thinkingLevel : undefined
              },
              sessionName: expectedTitle,
              assertBinding: assertAdoptionPolicy,
              action,
              initialSelection: selection,
              compaction: nextCompaction,
              promptPolicy: {
                hostAlias: promptPolicy.hostAlias,
                personaMarkdown: promptPolicy.personaMarkdown,
                contextRoot: promptPolicy.contextRoot,
                personaPath: promptPolicy.personaPath,
                contextFiles: promptPolicy.contextFiles,
                runtime: promptPolicy.runtime,
                memoryBlock: selected.memory?.memoryBlock,
                recoverySummary: promptPolicy.recoverySummary
              },
              tools: [...scopeTools.tools.filter((tool) => names.has(tool.name)), ...runTools],
              hostApprovalFor: (name, input) =>
                runTools.find((tool) => tool.name === name)?.approval ??
                scopeTools.approvalFor(name, input),
              nativeTools: selected.nativeTools,
              foregroundChildren: selected.foregroundChildren && {
                binding: deriveProductionChildBinding(binding, selected),
                definitions: selected.foregroundChildren.definitions,
                allowParallel: selected.foregroundChildren.allowParallel,
                allowBackground: selected.foregroundChildren.allowBackground,
                resources: {
                  skills: selected.foregroundChildren.resources?.skills ?? [],
                  hostTools: childTools!.hostTools
                },
                resolveEnvironment: selected.foregroundChildren.resolveEnvironment,
                classifyTool: (run, call) => childTools!.classify(run, call),
                executeHost: (run, call, signal) => childTools!.execute(run, call, signal),
                drainHost: (id) => childTools!.drain(id),
                onChildChange: (snapshot, parent) => {
                  if (!attachedReference || interrupted || closing) return
                  assertAdoptionPolicy()
                  recordChildRunRecovery(
                    { reference: attachedReference, snapshot },
                    { assertCurrent: assertAdoptionPolicy }
                  )
                  selected.foregroundChildren?.onChildChange?.(snapshot, parent)
                },
                onChildFinished: async (snapshot) => {
                  if (interrupted || closing || !runtime) return
                  const report = await runtime.readChildReport(snapshot)
                  if (interrupted || closing) return
                  await options.bridge.hostServices.invoke(
                    AGENT_RUN_HOST_METHODS.finished,
                    {
                      originSessionId: params.sessionId,
                      run: {
                        id: snapshot.id,
                        agent: snapshot.agent,
                        state:
                          snapshot.status === 'completed'
                            ? 'done'
                            : snapshot.status === 'aborted'
                              ? 'cancelled'
                              : 'error',
                        task: '',
                        startedAt: snapshot.startedAt,
                        completedAt: snapshot.completedAt,
                        toolCallId: snapshot.parentToolCallId,
                        ...(report
                          ? { report }
                          : { error: '专家任务未提供完整结果，请查看任务记录。' })
                      }
                    },
                    { originSessionId: params.sessionId, agentRunId: snapshot.id }
                  )
                },
                parentThinkingLevel: childThinkingLevel(
                  selection
                    ? selection.thinkingLevel === 'off'
                      ? undefined
                      : selection.thinkingLevel
                    : expectedThinking,
                  (selection?.model ?? bootModel).reasoning
                ),
                currentParentRun: () => {
                  const run = submittedRun
                  return run && options.runners.getActiveRun(phiSessionId) === run ? run : undefined
                },
                onApprovalEvent: createFacadeChildApprovalWriter({
                  phiSessionId,
                  cwd: binding.canonicalRoot,
                  runners: options.runners,
                  notify: selected.foregroundChildren.onApprovalEvent
                })
              },
              recentUserImages: scopeTools.recentUserImages,
              browserTextVault: vault,
              approval: selected.approval,
              signal: selection?.signal ?? signal,
              beforeCheckpoint: (checkpointSignal) => {
                if (firstCheckpoint) firstCheckpoint = false
                else {
                  const expected = attachedReference
                  adoption = beginRuntimeReferenceAdoption(phiSessionId, scope, generation, {
                    signal: checkpointSignal,
                    expectedOmpSessionId: expected?.ompSessionId,
                    expectedJournalBasename: expected?.journalBasename
                  })
                }
                const lease = adoption
                if (!lease) throw new Error('Phi adoption authority is unavailable')
                return () => {
                  lease.release()
                  if (adoption === lease) adoption = undefined
                }
              },
              adopt: async (snapshot, adoptionSignal) => {
                adoptionSignal.throwIfAborted()
                signal.throwIfAborted()
                assertAdoptionPolicy()
                // Project first, so an unsupported public shape cannot commit an unrenderable attachment.
                if (epoch !== runtimeEpoch)
                  throw new RuntimeReferenceError('STALE_GENERATION', '旧远程代次不能采用新状态')
                const projected = stateFrom(snapshot)
                if (rotating) selectionState = projected
                else state = projected
                if (!adoption) throw new Error('Phi adoption lease was retired')
                const { phiSessionId: adoptedPhiId, ...publicReference } = snapshot.reference
                if (adoptedPhiId !== phiSessionId) throw new Error('Verified Phi identity changed')
                const adopted = adoption.adopt({
                  ...publicReference,
                  checkpoint: {
                    leafId: snapshot.checkpoint.leafId,
                    verifiedAt: new Date().toISOString()
                  }
                })
                attachedReference = adopted.runtimeRef
              },
              onInterrupted: (error) => {
                if (epoch !== runtimeEpoch) return
                interrupted = error
                tools?.dispose()
                adoption?.release()
                detach?.()
                if (runtime && !rotating)
                  void runtime
                    .close(error)
                    .finally(disposeSelected)
                    .catch(() => undefined)
                selected.onInterrupted?.(error)
              }
            })
            return controlOwner
          }
          runtime = await startRuntime(
            model,
            reference
              ? {
                  type: 'resume',
                  reference: { ...reference, phiSessionId },
                  savedModel: savedModel!,
                  ...(replacement ? { replacement: chosenModel } : {})
                }
              : { type: 'new', model: chosenModel },
            reference
              ? {
                  model,
                  thinkingLevel: replacement
                    ? selectionThinking(model, expectedThinking, false).rpc
                    : (expectedThinking ?? 'off'),
                  assertCurrent: assertAdoptionPolicy,
                  signal
                }
              : undefined
          )
          state ??= stateFrom(runtime.currentSnapshot())
          assertAdoptionPolicy()
          if (replacement) {
            const confirmed = runtime.currentSnapshot()
            const next = { providerId: confirmed.model.provider, modelId: confirmed.model.id }
            const thinking =
              confirmed.thinkingLevel === 'off'
                ? undefined
                : (confirmed.thinkingLevel as ThinkingLevel | undefined)
            updateSessionManifest(phiSessionId, { model: next, thinkingLevel: thinking })
            expectedModel = next
            expectedThinking = thinking
          }
          // A recovery operation owns preparation only. Future user runs advance
          // its captured prompt generation while this verified session stays live.
          creationControl = undefined
          const currentState = (): WorkerSessionState => structuredClone(state!)
          const attachEvents = (owner: RemoteSessionRuntime): void => {
            detach = owner.onEvent((frame) => {
              if (runtime !== owner || rotating) return
              try {
                const event = projector.event(frame)
                if (event) sink.event(event)
              } catch (error) {
                void owner.close(error)
              }
            })
          }
          attachEvents(runtime)
          const changeSelection = async (
            requestedModel: RuntimeModel | undefined,
            requestedThinking: ThinkingLevel | undefined,
            thinkingOnly: boolean,
            control?: RuntimeSelectionControl,
            requestedAuto?: AutoCompactionOverrides
          ): Promise<WorkerSessionState> => {
            if (
              closing ||
              interrupted ||
              submittedRun ||
              metadataPending ||
              options.runners.getActiveRun(phiSessionId) ||
              runtime!.hasActiveAgentRuns() ||
              !runtime!.isReady
            )
              throw new Error('Remote selection requires an idle Phi session')
            const oldRuntime = runtime!
            const oldReference = attachedReference
            const controller = new AbortController()
            const assertCurrent = (): void => {
              signal.throwIfAborted()
              controller.signal.throwIfAborted()
              control?.assertCurrent()
              assertAdoptionPolicy()
              if (
                closing ||
                options.runners.getActiveRun(phiSessionId) ||
                JSON.stringify(findPhiSessionById(phiSessionId)?.runtimeRef) !==
                  JSON.stringify(attachedReference)
              )
                throw new RuntimeReferenceError('STALE_GENERATION', '远程选择的会话或代次已改变')
            }
            assertCurrent()
            metadataPending = true
            selectionAbort = controller
            let retired = false
            let candidate: RemoteSessionRuntime | undefined
            try {
              await oldRuntime.assertIdle(control)
              assertCurrent()
              const catalog = await options.models(params.agentDir)
              assertCurrent()
              const target = requestedModel ?? currentState().model
              const trusted = catalog.find(
                (item) => item.provider === target?.provider && item.id === target?.id
              )
              const bootModel = catalog.find(
                (item) =>
                  item.provider === expectedModel?.providerId && item.id === expectedModel?.modelId
              )
              if (!trusted || !bootModel || !oldReference)
                throw new Error('Selected model is unavailable in the trusted desktop registry')
              const nextAuto = requestedAuto ?? expectedAuto
              const resolvedCompaction = options.compactionPolicy
                ? await options.compactionPolicy(params.agentDir, nextAuto)
                : undefined
              const nextCompaction = resolvedCompaction
                ? compactionPolicy(resolvedCompaction.policy)
                : undefined
              assertCurrent()
              if (requestedAuto && !nextCompaction)
                throw new RemoteSessionCapabilityError('auto compaction policy resolver')
              const thinking = selectionThinking(
                trusted,
                thinkingOnly
                  ? requestedThinking
                  : (control?.preferredThinkingLevel ?? expectedThinking),
                thinkingOnly
              )
              if (thinkingOnly) {
                const levels = await oldRuntime.readThinkingLevels()
                assertCurrent()
                if (!levels.includes(thinking.rpc))
                  throw new Error('Remote SDK does not support the requested thinking level')
              }
              if (selected.foregroundChildren) childThinkingLevel(thinking.phi, trusted.reasoning)
              if (
                expectedModel?.providerId === trusted.provider &&
                expectedModel.modelId === trusted.id &&
                expectedThinking === thinking.phi &&
                JSON.stringify(nextAuto) === JSON.stringify(expectedAuto) &&
                JSON.stringify(nextCompaction) === JSON.stringify(currentCompaction)
              )
                return currentState()
              models = catalog
              await oldRuntime.assertIdle(control)
              assertCurrent()
              rotating = true
              retired = true
              ++runtimeEpoch // A retiring channel cannot close or publish through the replacement.
              detach?.()
              detach = undefined
              await oldRuntime.close()
              assertCurrent()
              candidate = await startRuntime(
                bootModel,
                {
                  type: 'resume',
                  reference: { ...oldReference, phiSessionId },
                  savedModel: { provider: bootModel.provider, id: bootModel.id }
                },
                {
                  model: trusted,
                  thinkingLevel: thinking.rpc,
                  assertCurrent,
                  signal: AbortSignal.any([signal, controller.signal])
                },
                nextCompaction
              )
              assertCurrent()
              if (!candidate.isReady || !selectionState)
                throw new Error('Remote selection did not produce a verified checkpoint')
              const next = { providerId: trusted.provider, modelId: trusted.id }
              updateSessionManifest(phiSessionId, {
                model: next,
                thinkingLevel: thinking.phi,
                autoCompaction: Object.keys(nextAuto).length ? nextAuto : undefined
              })
              expectedModel = next
              expectedThinking = thinking.phi
              expectedAuto = structuredClone(nextAuto)
              currentCompaction = nextCompaction
              currentCompactionDefaults = resolvedCompaction?.defaults
              runtime = candidate
              state = selectionState
              selectionState = undefined
              rotating = false
              attachEvents(candidate)
              sink.state(currentState())
              return currentState()
            } catch (error) {
              if (retired) {
                interrupted =
                  error instanceof Error ? error : new Error('Remote runtime interrupted')
                tools?.dispose()
                adoption?.release()
                await candidate?.close(error).catch(() => undefined)
                await oldRuntime.close(error).catch(() => undefined)
                await disposeSelected().catch(() => undefined)
              }
              throw error
            } finally {
              rotating = false
              metadataPending = false
              if (selectionAbort === controller) selectionAbort = undefined
            }
          }
          const beginSelection = (
            ...args: Parameters<typeof changeSelection>
          ): Promise<WorkerSessionState> => {
            const wasPending = metadataPending
            const operation = changeSelection(...args)
            if (!wasPending && metadataPending) {
              selectionPending = operation
              void operation
                .finally(() => {
                  if (selectionPending === operation) selectionPending = undefined
                })
                .catch(() => undefined)
            }
            return operation
          }
          selected.startupDiagnostics?.finish('ready')
          return {
            interruption: () => interrupted,
            hasActiveAgentRuns: () => !closing && !interrupted && runtime!.hasActiveAgentRuns(),
            agentRuns: {
              list: () =>
                runtime!
                  .listChildRuns()
                  .filter((run) => run.background)
                  .map(childJobView),
              resourceOwner: (id) => runtime!.childResourceOwner(id),
              steer: (id, message) => runtime!.steerChild(id, message),
              stop: (id) => runtime!.stopChild(id),
              wait: (options) => runtime!.waitForChildren(options)
            },
            get isLive() {
              return (
                !closing &&
                !interrupted &&
                !signal.aborted &&
                (runtime!.isReady || submittedRun !== undefined || metadataPending)
              )
            },
            state: currentState,
            async prompt(text, raw) {
              const run = options.runners.getActiveRun(phiSessionId)
              if (!run || run.sessionId !== phiSessionId || run.signal.aborted)
                throw new Error('Remote prompt requires the actual active Phi run')
              const pendingContextUsage = contextUsagePending
              if (pendingContextUsage) await pendingContextUsage.catch(() => undefined)
              if (options.runners.getActiveRun(phiSessionId) !== run || run.signal.aborted)
                throw new Error('Remote prompt requires the actual active Phi run')
              const prompt = promptOptions(raw)
              if (submittedRun || metadataPending || closing || interrupted || !runtime!.isReady) {
                if (interrupted) throw interrupted
                throw new Error('Remote runtime cannot admit this prompt')
              }
              submittedRun = run
              try {
                let result
                try {
                  result = await runtime!.prompt(run.runId, text, prompt, run.signal)
                } catch (error) {
                  interrupted =
                    error instanceof Error ? error : new Error('Remote runtime interrupted')
                  tools?.dispose()
                  adoption?.release()
                  throw error
                }
                if (options.runners.getActiveRun(phiSessionId) !== run)
                  throw new RuntimeReferenceError('STALE_GENERATION', 'Phi 运行已被替换')
                state = stateFrom(result.snapshot)
                sink.state(currentState())
                if (result.outcome === 'completed' && selected.memory) {
                  try {
                    await selected.memory.ingest({
                      runId: run.runId,
                      snapshot: result.snapshot,
                      outcome: 'completed',
                      signal: run.signal
                    })
                  } catch {
                    selected.memory.retire()
                    try {
                      await selected.onMemoryError?.()
                    } catch {
                      /* Safe diagnostics cannot change the completed chat. */
                    }
                  }
                }
                if (result.outcome === 'failed') throw remoteTurnFailure(result)
                return currentState()
              } finally {
                try {
                  await tools?.captureNotebookExecutionDrain(run.runId)()
                } finally {
                  if (submittedRun === run) submittedRun = undefined
                }
              }
            },
            setModel: (next, control) => beginSelection(next, undefined, false, control),
            setThinkingLevel: (level, control) => beginSelection(undefined, level, true, control),
            async autoCompactionSettings(control) {
              signal.throwIfAborted()
              control?.assertCurrent()
              assertAdoptionPolicy()
              if (closing || interrupted || !currentCompaction || !currentCompactionDefaults)
                throw new Error('Confirmed auto compaction settings are unavailable')
              if (metadataPending)
                throw new Error('Auto compaction settings require a settled control operation')
              if (!runtime!.isReady && !submittedRun && !options.runners.getActiveRun(phiSessionId))
                throw new Error('Auto compaction settings require an attached runtime')
              if (
                runtime!.isReady &&
                !submittedRun &&
                !options.runners.getActiveRun(phiSessionId)
              ) {
                metadataPending = true
                try {
                  await runtime!.readCompactionPolicy()
                  control?.assertCurrent()
                  assertAdoptionPolicy()
                } finally {
                  metadataPending = false
                }
              }
              return {
                enabled: currentCompaction.enabled && currentCompaction.methodOrder.length > 0,
                thresholdPercent: currentCompaction.thresholdPercent,
                thresholdTokens: currentCompaction.thresholdTokens,
                defaults: structuredClone(currentCompactionDefaults)
              }
            },
            async setAutoCompactionSettings(overrides, control) {
              if (
                Object.keys(overrides).some(
                  (key) => !['enabled', 'thresholdPercent'].includes(key)
                ) ||
                (overrides.enabled !== undefined && typeof overrides.enabled !== 'boolean') ||
                (overrides.thresholdPercent !== undefined &&
                  ![70, 80, 90].includes(overrides.thresholdPercent))
              )
                throw new Error('Invalid auto compaction overrides')
              await beginSelection(undefined, undefined, false, control, structuredClone(overrides))
              const policy = currentCompaction!
              return {
                enabled: policy.enabled && policy.methodOrder.length > 0,
                thresholdPercent: policy.thresholdPercent,
                thresholdTokens: policy.thresholdTokens,
                defaults: currentCompactionDefaults!
              }
            },
            async compact(control) {
              if (
                closing ||
                interrupted ||
                submittedRun ||
                metadataPending ||
                options.runners.getActiveRun(phiSessionId) ||
                runtime!.hasActiveAgentRuns() ||
                !runtime!.isReady
              )
                throw new Error('Compaction requires an idle Phi session')
              metadataPending = true
              const owner = runtime!
              let completed = false
              const assertCurrent = (): void => {
                signal.throwIfAborted()
                control?.assertCurrent()
                assertAdoptionPolicy()
                if (runtime !== owner || closing) throw new Error('Compaction generation changed')
              }
              try {
                const operation = owner.compact({ assertCurrent })
                compactionPending = operation
                const result = await operation
                completed = true
                assertCurrent()
                state = stateFrom(result.snapshot)
                sink.state(currentState())
                return {
                  summary: result.summary as ContextCompactionSummary,
                  state: currentState()
                }
              } catch (error) {
                if (completed || !owner.isReady) {
                  await owner.close(error).catch(() => undefined)
                  interrupted =
                    error instanceof Error ? error : new Error('Remote runtime interrupted')
                  tools?.dispose()
                  adoption?.release()
                  await disposeSelected().catch(() => undefined)
                }
                throw error
              } finally {
                compactionPending = undefined
                metadataPending = false
              }
            },
            async contextUsage() {
              const idle = !closing && !submittedRun && !metadataPending &&
                !options.runners.getActiveRun(phiSessionId) && !runtime!.hasActiveAgentRuns() &&
                runtime!.isReady
              if (!idle) throw new RemoteMetadataBusyError('Phi session')
              metadataPending = true
              contextUsagePending = runtime!.readContextUsage().finally(() => {
                metadataPending = false
                contextUsagePending = undefined
              })
              return contextUsagePending
            },
            async rename(rawName, control) {
              const name = canonicalRemoteSessionName(rawName)
              if (
                closing ||
                submittedRun ||
                metadataPending ||
                options.runners.getActiveRun(phiSessionId) ||
                runtime!.hasActiveAgentRuns() ||
                !runtime!.isReady
              )
                throw new RemoteMetadataBusyError('Phi session')
              assertAdoptionPolicy()
              const assertCurrent = (): void => {
                control?.assertCurrent()
                signal.throwIfAborted()
                assertAdoptionPolicy()
                if (
                  JSON.stringify(findPhiSessionById(phiSessionId)?.runtimeRef) !==
                  JSON.stringify(attachedReference)
                )
                  throw new RuntimeReferenceError(
                    'STALE_GENERATION',
                    'Phi metadata reference changed'
                  )
              }
              metadataPending = true
              try {
                const snapshot = await runtime!.rename(name, {
                  assertCurrent,
                  beforeWrite() {
                    assertCurrent()
                    updateSessionManifest(phiSessionId, { title: name })
                    expectedTitle = name
                  }
                })
                state = stateFrom(snapshot)
                sink.state(currentState())
                return currentState()
              } finally {
                metadataPending = false
              }
            },
            async abort() {
              if (compactionPending) {
                await runtime!.stop()
                return currentState()
              }
              const pendingSelection = selectionPending
              selectionAbort?.abort(new Error('Remote selection cancelled'))
              if (pendingSelection) await pendingSelection
              const run = submittedRun
              const drain = run && tools?.captureNotebookExecutionDrain(run.runId)
              stopSubmittedRun()
              let failed = false,
                failure: unknown
              try {
                if (run || runtime!.hasActiveAgentRuns()) await runtime!.stop()
              } catch (error) {
                failed = true
                failure = error
              }
              try {
                await drain?.()
              } catch (error) {
                if (!failed) {
                  failed = true
                  failure = error
                }
              }
              if (failed) throw failure
              return currentState()
            },
            dispose() {
              return (closing ??= (async () => {
                const pendingSelection = selectionPending
                selectionAbort?.abort(new Error('Remote selection disposed'))
                await pendingSelection?.catch(() => undefined)
                const drain = tools?.captureNotebookExecutionDrain()
                stopSubmittedRun()
                let failed = false
                let failure: unknown
                try {
                  if (submittedRun) await runtime!.stop()
                } catch (error) {
                  failed = true
                  failure = error
                }
                try {
                  await runtime!.close()
                } catch (error) {
                  if (!failed) {
                    failed = true
                    failure = error
                  }
                } finally {
                  detach?.()
                  adoption?.release()
                  tools?.dispose()
                  try {
                    await childTools?.drain()
                  } catch (error) {
                    if (!failed) {
                      failed = true
                      failure = error
                    }
                  }
                  try {
                    await drain?.()
                  } catch (error) {
                    if (!failed) {
                      failed = true
                      failure = error
                    }
                  }
                  try {
                    await disposeSelected()
                  } catch (error) {
                    if (!failed) {
                      failed = true
                      failure = error
                    }
                  }
                }
                if (failed) throw failure
              })())
            }
          }
        } catch (error) {
          await runtime?.close(error)
          await childTools?.drain().catch(() => undefined)
          initialAdoption.release()
          adoption?.release()
          tools?.dispose()
          detach?.()
          throw error
        }
      } catch (error) {
        selected.startupDiagnostics?.finish('failed')
        await disposeSelected().catch(() => undefined)
        throw error
      }
    }
  }
}
