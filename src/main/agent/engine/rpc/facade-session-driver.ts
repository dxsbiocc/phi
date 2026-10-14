import { createHash, randomUUID } from 'node:crypto'
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
import {
  RemoteSessionCapabilityError,
  type RoutedSessionDriver,
  type RoutedSessionFactory
} from '../session-routing-engine'
import { createRpcDesktopToolScope, type RpcDesktopToolScopeOptions } from './desktop-tool-scope'
import {
  RemoteSessionRuntime,
  type RemoteRuntimeSnapshot,
  type RemoteSessionRuntimeOptions
} from './remote-session-runtime'
import { prepareRemoteSessionStorage } from './session-storage/writer-lease'
import type { RemoteSessionScope } from './session-storage/types'
import { canonicalRemoteSessionName } from './runtime-metadata-control'
import { RpcFacadeEventProjector } from './facade-event-projection'
import type { RpcPromptOptions } from './types'
import type { RpcApprovalEvent } from './approval-bridge'
import { createFacadeChildApprovalWriter } from './facade-child-approval'
import type { PhiAgentDefinition, PhiAgentThinkingLevel } from '../../agents/definition'
import { deriveProductionChildBinding } from './subagents/production-child-config'

export interface SelectedFacadeRuntime {
  readonly hostProfileId: string
  /** Exact selected project/profile binding, never host-alias-only identity. */
  readonly bindingHash: string
  readonly projectId: string
  readonly projectRoot: string
  readonly runtime: RemoteSessionRuntimeOptions['transport']['runtime']
  readonly session: RemoteSessionRuntimeOptions['transport']['session']
  readonly bundle: RemoteSessionRuntimeOptions['transport']['bundle']
  readonly recovery: 'new' | 'resume'
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
    /** Notification only; the facade is the single durable approval writer. */
    readonly onApprovalEvent?: (event: RpcApprovalEvent, parent: SessionRun) => void | Promise<void>
  }
  readonly onInterrupted?: (error: Error) => void
  /** Application-owned SSH/runtime workspace, released after its last runtime channel. */
  readonly dispose?: () => void | Promise<void>
}
export interface FacadeSessionFactoryOptions {
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
    params.memory ||
    params.personaMarkdown ||
    params.resourceOptions ||
    params.autoCompaction ||
    params.phiAgents?.length ||
    params.remoteProjectMcpServers?.length ||
    params.remoteProject?.contextFiles.length
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
    async create(params, signal, sink): Promise<RoutedSessionDriver> {
      signal.throwIfAborted()
      if (!params.remoteProject) throw new Error('Remote facade requires an explicit SSH project')
      capabilityGuard(params)
      const { phiSessionId, projectId, location } = params.remoteProject
      const binding = resolveRemoteWorkspaceHostBinding({ sessionId: phiSessionId, projectId })
      const initial = findPhiSessionById(phiSessionId)
      if (!initial) throw new Error('Phi session does not exist')
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
        (selectedCleanup ??= Promise.resolve().then(() => selected.dispose?.()))
      try {
        signal.throwIfAborted()
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
        const chosenModel = reference
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
          chosenModel.provider !== savedModel.provider ||
          chosenModel.id !== savedModel.id ||
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
        let interrupted = false
        let metadataPending = false
        let selectionAbort: AbortController | undefined
        let selectionPending: Promise<WorkerSessionState> | undefined
        let submittedRun: SessionRun | undefined
        const stopSubmittedRun = (): void => {
          const run = submittedRun
          if (run && options.runners.getActiveRun(phiSessionId) === run)
            options.runners.stopRun(phiSessionId)
        }
        const vault = new BrowserTextVault()
        let tools: ReturnType<typeof createRpcDesktopToolScope> | undefined
        try {
          tools = createRpcDesktopToolScope({
            identity: {
              runtimeSessionId: params.sessionId,
              sessionId: phiSessionId,
              projectId,
              cwd: binding.canonicalRoot
            },
            services: options.bridge.hostServices,
            currentRun: () => runtime?.currentRun(),
            assertBinding: selected.desktopTools?.assertBinding,
            recentUserImages: selected.recentUserImages,
            allowBrowserTypeText: () => selected.desktopToolNames.includes('browser'),
            browserTextVault: vault,
            agentDir: params.agentDir,
            allowedSkills: selected.desktopTools?.allowedSkills ?? [],
            skillCatalog: selected.desktopTools?.skillCatalog,
            scriptTools: selected.desktopTools?.scriptTools ?? [],
            scriptApprovalFor: selected.desktopTools?.scriptApprovalFor,
            paletteCatalogPath: selected.desktopTools?.paletteCatalogPath,
            remoteLibrary: selected.desktopTools?.remoteLibrary,
            desktopWebSearch: selected.desktopTools?.desktopWebSearch,
            desktopMcp: selected.desktopTools?.desktopMcp
          })
          const projector = new RpcFacadeEventProjector()
          const scopeTools = tools
          const names = new Set(selected.desktopToolNames)
          if (
            names.size !== selected.desktopToolNames.length ||
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
            throw new Error('Selected remote model is unavailable in the real desktop registry')
          const stateFrom = (snapshot: RemoteRuntimeSnapshot): WorkerSessionState =>
            workerState(snapshot, initial.cwd, phiSessionId, models, projector)
          let state: WorkerSessionState | undefined
          let expectedModel = initial.model
          let expectedThinking = initial.thinkingLevel
          let rotating = false
          let runtimeEpoch = 0
          let selectionState: WorkerSessionState | undefined
          const assertAdoptionPolicy = (): void => {
            const latest = findPhiSessionById(phiSessionId)
            if (
              !latest ||
              JSON.stringify(latest.model) !== JSON.stringify(expectedModel) ||
              latest.thinkingLevel !== expectedThinking
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
            selection?: RuntimeInitialSelection
          ): Promise<RemoteSessionRuntime> => {
            const epoch = ++runtimeEpoch
            const refs = [bootModel, ...(selection ? [selection.model] : [])]
              .filter(
                (value, index, all) =>
                  all.findIndex(
                    (item) => item.provider === value.provider && item.id === value.id
                  ) === index
              )
              .map(({ provider, id }) => ({ provider, id }))
            return RemoteSessionRuntime.create({
              transport: {
                projectId,
                runtime: selected.runtime,
                session: selected.session,
                bundle: selected.bundle,
                gateway: options.bridge,
                models: refs,
                preparePersistentStorage: ({ signal: storageSignal }) =>
                  prepareRemoteSessionStorage({
                    runtimeHost: selected.runtime.runtimeHost,
                    scope,
                    signal: storageSignal,
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
              action,
              initialSelection: selection,
              tools: scopeTools.tools.filter((tool) => names.has(tool.name)),
              hostApprovalFor: scopeTools.approvalFor,
              nativeTools: selected.nativeTools,
              foregroundChildren: selected.foregroundChildren && {
                binding: deriveProductionChildBinding(binding, selected),
                definitions: selected.foregroundChildren.definitions,
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
                interrupted = true
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
          }
          runtime = await startRuntime(
            model,
            reference
              ? {
                  type: 'resume',
                  reference: { ...reference, phiSessionId },
                  savedModel: chosenModel
                }
              : { type: 'new', model: chosenModel },
            reference
              ? {
                  model,
                  thinkingLevel: expectedThinking ?? 'off',
                  assertCurrent: assertAdoptionPolicy,
                  signal
                }
              : undefined
          )
          state ??= stateFrom(runtime.currentSnapshot())
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
            control?: RuntimeSelectionControl
          ): Promise<WorkerSessionState> => {
            if (
              closing ||
              interrupted ||
              submittedRun ||
              metadataPending ||
              options.runners.getActiveRun(phiSessionId) ||
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
                expectedThinking === thinking.phi
              )
                return currentState()
              models = catalog
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
                }
              )
              assertCurrent()
              if (!candidate.isReady || !selectionState)
                throw new Error('Remote selection did not produce a verified checkpoint')
              const next = { providerId: trusted.provider, modelId: trusted.id }
              updateSessionManifest(phiSessionId, { model: next, thinkingLevel: thinking.phi })
              expectedModel = next
              expectedThinking = thinking.phi
              runtime = candidate
              state = selectionState
              selectionState = undefined
              rotating = false
              attachEvents(candidate)
              sink.state(currentState())
              return currentState()
            } catch (error) {
              if (retired) {
                interrupted = true
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
          return {
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
              const prompt = promptOptions(raw)
              if (submittedRun || closing || interrupted || !runtime!.isReady)
                throw new Error('Remote runtime cannot admit this prompt')
              submittedRun = run
              try {
                let result
                try {
                  result = await runtime!.prompt(run.runId, text, prompt, run.signal)
                } catch (error) {
                  interrupted = true
                  tools?.dispose()
                  adoption?.release()
                  throw error
                }
                if (options.runners.getActiveRun(phiSessionId) !== run)
                  throw new RuntimeReferenceError('STALE_GENERATION', 'Phi 运行已被替换')
                state = stateFrom(result.snapshot)
                sink.state(currentState())
                if (result.outcome === 'failed')
                  throw new Error('Remote turn failed or approval was denied')
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
            async contextUsage() {
              if (
                closing ||
                submittedRun ||
                metadataPending ||
                options.runners.getActiveRun(phiSessionId) ||
                !runtime!.isReady
              )
                throw new Error('Remote metadata requires an idle Phi session')
              metadataPending = true
              try {
                return await runtime!.readContextUsage()
              } finally {
                metadataPending = false
              }
            },
            async rename(rawName) {
              const name = canonicalRemoteSessionName(rawName)
              if (
                closing ||
                submittedRun ||
                metadataPending ||
                options.runners.getActiveRun(phiSessionId) ||
                !runtime!.isReady
              )
                throw new Error('Remote metadata requires an idle Phi session')
              assertAdoptionPolicy()
              const assertCurrent = (): void => {
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
              const pendingSelection = selectionPending
              selectionAbort?.abort(new Error('Remote selection cancelled'))
              if (pendingSelection) await pendingSelection
              const run = submittedRun
              const drain = run && tools?.captureNotebookExecutionDrain(run.runId)
              stopSubmittedRun()
              let failed = false,
                failure: unknown
              try {
                if (run) await runtime!.stop()
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
          initialAdoption.release()
          adoption?.release()
          tools?.dispose()
          detach?.()
          throw error
        }
      } catch (error) {
        await disposeSelected().catch(() => undefined)
        throw error
      }
    }
  }
}
