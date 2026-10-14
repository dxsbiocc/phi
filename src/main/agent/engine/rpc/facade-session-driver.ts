import { createHash, randomUUID } from 'node:crypto'
import { BrowserTextVault } from '../../browser/browser-text-vault'
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
import type { PhiSessionCreateParams, RuntimeModel, WorkerSessionState } from '../types'
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
    'allowedSkills' | 'scriptTools' | 'scriptApprovalFor' | 'paletteCatalogPath'
  >
  readonly recentUserImages: RpcDesktopToolScopeOptions['recentUserImages']
  readonly nativeTools?: RemoteSessionRuntimeOptions['nativeTools']
  readonly onInterrupted?: (error: Error) => void
}
export interface FacadeSessionFactoryOptions {
  /** The real singleton whose host registry is populated by engine.host.register. */
  readonly bridge: OmpBridge
  readonly models: (agentDir: string) => Promise<readonly RuntimeModel[]>
  /** Actual application SessionRunnerRegistry, not a run identifier from prompt options. */
  readonly runners: SessionRunnerRegistry
  /** Main-only, synchronous snapshot of the already selected SSH runtime. */
  readonly selected: (identity: {
    runtimeSessionId: string
    phiSessionId: string
    projectId: string
  }) => SelectedFacadeRuntime
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
    desktopTools:
      selected.desktopTools &&
      Object.freeze({
        ...selected.desktopTools,
        allowedSkills: Object.freeze([...selected.desktopTools.allowedSkills]),
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
        options.selected({
          runtimeSessionId: params.sessionId,
          phiSessionId,
          projectId
        })
      )
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
          recentUserImages: selected.recentUserImages,
          allowBrowserTypeText: () => false,
          browserTextVault: vault,
          agentDir: params.agentDir,
          allowedSkills: selected.desktopTools?.allowedSkills ?? [],
          scriptTools: selected.desktopTools?.scriptTools ?? [],
          scriptApprovalFor: selected.desktopTools?.scriptApprovalFor,
          paletteCatalogPath: selected.desktopTools?.paletteCatalogPath
        })
        const projector = new RpcFacadeEventProjector()
        const scopeTools = tools
        const names = new Set(selected.desktopToolNames)
        if (
          names.size !== selected.desktopToolNames.length ||
          names.has('browser') ||
          [...names].some((name) => !scopeTools.tools.some((tool) => tool.name === name))
        )
          throw new RemoteSessionCapabilityError('desktop tool roster/browser privacy')
        const models = await options.models(params.agentDir)
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
        const assertAdoptionPolicy = (): void => {
          const latest = findPhiSessionById(phiSessionId)
          if (
            !latest ||
            JSON.stringify(latest.model) !== JSON.stringify(initial.model) ||
            latest.thinkingLevel !== initial.thinkingLevel
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
        runtime = await RemoteSessionRuntime.create({
          transport: {
            projectId,
            runtime: selected.runtime,
            session: selected.session,
            bundle: selected.bundle,
            gateway: options.bridge,
            models: [{ provider: model.provider, id: model.id }],
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
            model,
            thinkingLevel: reference ? undefined : params.thinkingLevel
          },
          sessionName: expectedTitle,
          action: reference
            ? { type: 'resume', reference: { ...reference, phiSessionId }, savedModel: chosenModel }
            : { type: 'new', model: chosenModel },
          tools: tools.tools.filter((tool) => names.has(tool.name)),
          hostApprovalFor: tools.approvalFor,
          nativeTools: selected.nativeTools,
          recentUserImages: tools.recentUserImages,
          approval: selected.approval,
          signal,
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
            state = stateFrom(snapshot)
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
            interrupted = true
            tools?.dispose()
            adoption?.release()
            detach?.()
            selected.onInterrupted?.(error)
          }
        })
        state ??= stateFrom(runtime.currentSnapshot())
        const currentState = (): WorkerSessionState => structuredClone(state!)
        detach = runtime.onEvent((frame) => {
          try {
            const event = projector.event(frame)
            if (event) sink.event(event)
          } catch (error) {
            void runtime!.close(error)
          }
        })
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
              if (submittedRun === run) submittedRun = undefined
            }
          },
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
            stopSubmittedRun()
            if (submittedRun) await runtime!.stop()
            return currentState()
          },
          dispose() {
            return (closing ??= (async () => {
              stopSubmittedRun()
              try {
                if (submittedRun) await runtime!.stop()
              } finally {
                await runtime!.close()
                detach?.()
                adoption?.release()
                tools?.dispose()
              }
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
    }
  }
}
