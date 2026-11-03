import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'

import { writeAppLog, type AppLogEntry } from './app-logger'
import { getProject } from './projects'
import { resolveRemoteWorkspaceHostBinding } from './remote-workspace-boundary'
import { openRemoteRuntimeWorkspace } from './remote-runtime/workspace'
import { getPhiEngine, getPhiEngineBridge, type PhiEngineBridge } from './engine/in-process-engine'
import type {
  KernelSessionConnection,
  KernelSessionLaunchContext,
  KernelSessionLauncher
} from './engine/kernel-session-factory'
import type { PhiSessionCreateParams } from './engine/types'
import { launchLocalKernel } from './engine/kernel-client'
import { launchRemoteKernel } from './engine/kernel-client/remote'
import {
  createDesktopModelAccessOwner,
  type DesktopModelAccessOwner
} from './engine/kernel-host/desktop-model-access'
import type { RemoteReverseTunnel } from './wrappers/remote-ssh-session'
import { facadeBindingHash } from './engine/rpc/facade-session-driver'
import { probeRemoteKernelHistory, readAndPlanKernelHistory } from './engine/kernel-history'
import { getSessionDir } from './session/session-store'
import { AppKernelDesktopServices } from './app-kernel-desktop-services'
import { isModelEnabled, readModelAvailability } from './model-availability'
import type { ModelAvailabilitySettings } from '../../shared/modelAvailabilityTypes'
import type { ModelAccessConfigureParams } from '../../shared/kernel-protocol'
import type { ModelGatewayModelRef } from './engine/model-gateway-types'
import type { RuntimeModel, RuntimeSnapshot } from './engine/types'
import { isSelectableRuntimeModel } from './runtime/runtime-model-selection'
import type {
  AppRemoteSessionRoutingDependencies,
  AppRemoteSessionRoutingOptions
} from './remote-session-routing'

function localKernelTarget(): 'darwin-arm64' | 'linux-x64' {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'darwin-arm64'
  if (process.platform === 'linux' && process.arch === 'x64') return 'linux-x64'
  throw new Error(
    `The kernel engine has no local build target for ${process.platform}/${process.arch}.`
  )
}

function kernelBuildDirectory(
  paths: ReturnType<AppRemoteSessionRoutingOptions['appPaths']>,
  target: 'darwin-arm64' | 'linux-x64'
): string {
  return paths.isPackaged
    ? join(paths.resourcesPath, 'kernel', paths.version ?? '0.0.0', target)
    : join(paths.appPath, '.phi-build', 'kernel', paths.version ?? '0.0.0', target)
}

// Kernel stderr carries the real cause behind INTERNAL protocol errors.
export function kernelDiagnosticLogEntry(
  target: 'local' | 'remote',
  text: string
): AppLogEntry | undefined {
  const raw = text.trim()
  if (!raw) return undefined
  try {
    const diagnostic = JSON.parse(raw) as Record<string, unknown>
    const message =
      typeof diagnostic.message === 'string' && diagnostic.message ? diagnostic.message : raw
    return {
      level: diagnostic.level === 'error' ? 'error' : 'warn',
      event: 'kernel_diagnostic',
      metadata: {
        target,
        message,
        ...(diagnostic.details && typeof diagnostic.details === 'object'
          ? { details: diagnostic.details }
          : {})
      }
    }
  } catch {
    return { level: 'warn', event: 'kernel_diagnostic', metadata: { target, message: raw } }
  }
}

function logKernelDiagnostic(target: 'local' | 'remote', text: string): void {
  const entry = kernelDiagnosticLogEntry(target, text)
  if (entry) writeAppLog(entry)
}

// A packaged appPath is the app.asar archive (a file), so spawning there fails
// with ENOTDIR; the kernel package directory is a real directory beside it.
export function kernelLaunchCwd(
  paths: ReturnType<AppRemoteSessionRoutingOptions['appPaths']>,
  buildDirectory: string
): string {
  return paths.isPackaged ? buildDirectory : paths.appPath
}

let kernelModelGatewayGeneration = 0
const MODEL_GATEWAY_MODEL_LIMIT = 256

type OwnedModelGatewayLease = Awaited<ReturnType<PhiEngineBridge['createModelGatewayLease']>>

/**
 * A desktop snapshot contains every built-in provider model (currently thousands), while a
 * gateway lease is deliberately bounded. Keep the selected model first, then publish only
 * configured, enabled models that a live remote kernel can actually use.
 */
export function selectRemoteKernelGatewayModels(
  snapshot: RuntimeSnapshot,
  selected: RuntimeModel,
  availability: ModelAvailabilitySettings
): readonly ModelGatewayModelRef[] {
  const configured = new Set(
    snapshot.providers
      .filter((provider) => provider.status?.configured === true)
      .map((provider) => provider.id)
  )
  for (const credential of snapshot.credentials) configured.add(credential.providerId)
  const selectedAvailable = snapshot.models.some(
    (model) => model.provider === selected.provider && model.id === selected.id
  )
  if (
    !selectedAvailable ||
    selected.cursorRichRoutes === true ||
    !isSelectableRuntimeModel(selected) ||
    !isModelEnabled(availability, selected.provider, selected.id)
  ) {
    throw new Error('Selected remote kernel model is unavailable.')
  }
  const refs: ModelGatewayModelRef[] = []
  const seen = new Set<string>()
  // Cursor's catalog is large; it must not crowd other configured providers out of the lease.
  const candidates = [
    selected,
    ...snapshot.models.filter((model) => model.provider !== 'cursor'),
    ...snapshot.models.filter((model) => model.provider === 'cursor')
  ]
  for (const model of candidates) {
    const selectedModel = model.provider === selected.provider && model.id === selected.id
    if (
      model.cursorRichRoutes === true ||
      !isSelectableRuntimeModel(model) ||
      (!selectedModel && !configured.has(model.provider)) ||
      !isModelEnabled(availability, model.provider, model.id)
    ) {
      continue
    }
    const key = JSON.stringify([model.provider, model.id])
    if (seen.has(key)) continue
    seen.add(key)
    refs.push(Object.freeze({ provider: model.provider, id: model.id }))
    if (refs.length === MODEL_GATEWAY_MODEL_LIMIT) break
  }
  return Object.freeze(refs)
}

type RemoteTarget = {
  remote: NonNullable<PhiSessionCreateParams['remoteProject']>
  binding: ReturnType<typeof resolveRemoteWorkspaceHostBinding>
  workspace: Awaited<ReturnType<typeof openRemoteRuntimeWorkspace>>
  session: Awaited<
    ReturnType<ReturnType<typeof resolveRemoteWorkspaceHostBinding>['config']['connect']>
  >
}

async function openRemoteTarget(
  options: AppRemoteSessionRoutingOptions,
  dependencies: AppRemoteSessionRoutingDependencies,
  params: PhiSessionCreateParams,
  signal: AbortSignal
): Promise<RemoteTarget> {
  const remote = params.remoteProject
  if (!remote) throw new Error('Remote kernel launch requires a trusted SSH project.')
  const project = getProject(remote.projectId)
  if (!project || project.location.kind !== 'ssh') {
    throw new Error('Remote kernel project is unavailable.')
  }
  const binding = (dependencies.resolveBinding ?? resolveRemoteWorkspaceHostBinding)({
    sessionId: remote.phiSessionId,
    projectId: remote.projectId
  })
  const workspace = await (dependencies.openWorkspace ?? openRemoteRuntimeWorkspace)(
    {
      runtimeSessionId: params.sessionId,
      sessionId: remote.phiSessionId,
      projectId: remote.projectId,
      configuredRoot: options.configuredRoot(project)
    },
    signal,
    () => binding
  )
  try {
    const session = await binding.config.connect()
    if (!session.openStdio || !session.openReverseTunnel) {
      throw new Error('Selected SSH transport lacks kernel attach/tunnel support.')
    }
    return { remote, binding, workspace, session }
  } catch (error) {
    await workspace.close?.()
    throw error
  }
}

/** Cursor rows the scoped lease refuses must not take other providers' remote sessions down. */
async function createRemoteGatewayLease(
  sessionId: string,
  catalog: readonly ModelGatewayModelRef[],
  selected: RuntimeModel,
  signal: AbortSignal
): Promise<OwnedModelGatewayLease> {
  const create = (models: readonly ModelGatewayModelRef[]): Promise<OwnedModelGatewayLease> =>
    getPhiEngineBridge().createModelGatewayLease(
      { sessionId, generation: ++kernelModelGatewayGeneration, models },
      signal
    )
  try {
    return await create(catalog)
  } catch (error) {
    const withoutCursor = catalog.filter((model) => model.provider !== 'cursor')
    if (
      signal.aborted ||
      selected.provider === 'cursor' ||
      withoutCursor.length === catalog.length
    ) {
      throw error
    }
    writeAppLog({ level: 'warn', event: 'remote_kernel_cursor_lease_skipped' })
    return create(withoutCursor)
  }
}

type RemoteModelProxy = {
  gateway: OwnedModelGatewayLease
  tunnel: RemoteReverseTunnel
  cursorTunnel: RemoteReverseTunnel | undefined
}

async function openRemoteModelProxy(
  params: PhiSessionCreateParams,
  target: RemoteTarget,
  signal: AbortSignal
): Promise<RemoteModelProxy> {
  const selected = params.model
  if (!selected) throw new Error('Remote kernel launch requires a selected model.')
  const snapshot = await getPhiEngine().models.snapshot({ agentDir: params.agentDir })
  const catalog = selectRemoteKernelGatewayModels(
    snapshot,
    selected,
    readModelAvailability(params.agentDir)
  )
  const gateway = await createRemoteGatewayLease(
    `kernel-${target.remote.location.hostProfileId}`,
    catalog,
    selected,
    signal
  )
  let tunnel: RemoteReverseTunnel | undefined
  try {
    tunnel = await target.session.openReverseTunnel!({
      localPort: gateway.localPort,
      signal
    })
    const cursorTunnel = gateway.cursor
      ? await target.session.openReverseTunnel!({ localPort: gateway.cursor.localPort, signal })
      : undefined
    return { gateway, tunnel, cursorTunnel }
  } catch (error) {
    await Promise.allSettled([tunnel?.close(), gateway.close()])
    throw error
  }
}

function remoteModelAccess(proxy: RemoteModelProxy): ModelAccessConfigureParams {
  return {
    endpoint: `http://127.0.0.1:${proxy.tunnel.remotePort}/v1/pi/stream`,
    bearerToken: proxy.gateway.bearerToken,
    models: proxy.gateway.models,
    ...(proxy.cursorTunnel && proxy.gateway.cursor
      ? {
          cursor: {
            baseUrl: `http://127.0.0.1:${proxy.cursorTunnel.remotePort}`,
            bearerToken: proxy.gateway.cursor.bearerToken
          }
        }
      : {})
  }
}

function remoteHistoryPlan(
  target: RemoteTarget,
  signal: AbortSignal,
  candidate: PhiSessionCreateParams
): ReturnType<typeof readAndPlanKernelHistory> {
  const phiSessionId = candidate.phiSessionId ?? candidate.remoteProject?.phiSessionId
  if (!phiSessionId) throw new Error('Remote kernel history needs a Phi session id.')
  return readAndPlanKernelHistory({
    phiSessionDirectory: getSessionDir(phiSessionId, candidate.agentDir),
    phiSessionId,
    expectedRemoteScope: {
      hostProfileId: target.remote.location.hostProfileId,
      bindingHash: facadeBindingHash(target.binding),
      projectId: target.remote.projectId,
      projectRoot: target.remote.location.canonicalRoot,
      runtimeRoot: target.workspace.runtimeRoot
    },
    probeRemoteOwnership: (reference, manifest) =>
      probeRemoteKernelHistory(target.session, reference, manifest, signal)
  })
}

async function launchAppRemoteKernel(input: {
  options: AppRemoteSessionRoutingOptions
  dependencies: AppRemoteSessionRoutingDependencies
  active: Set<() => Promise<void>>
  params: PhiSessionCreateParams
  context: KernelSessionLaunchContext
  signal: AbortSignal
}): Promise<KernelSessionConnection> {
  input.signal.throwIfAborted()
  const target = await openRemoteTarget(
    input.options,
    input.dependencies,
    input.params,
    input.signal
  )
  let proxy: RemoteModelProxy | undefined
  let launched: Awaited<ReturnType<typeof launchRemoteKernel>> | undefined
  try {
    proxy = await openRemoteModelProxy(input.params, target, input.signal)
    const paths = input.options.appPaths()
    launched = await launchRemoteKernel({
      session: target.session,
      runtimeHost: target.workspace.runtimeHost,
      runtimeRoot: target.workspace.runtimeRoot,
      buildDirectory: kernelBuildDirectory(paths, 'linux-x64'),
      signal: input.signal,
      environment: { PHI_KERNEL_ADOPT_ROOTS: target.workspace.runtimeRoot },
      configureClient: input.context.configureClient,
      onDiagnostic: (text: string) => logKernelDiagnostic('remote', text),
      onProgress: (progress) => {
        const phiSessionId = input.params.phiSessionId ?? input.params.remoteProject?.phiSessionId
        if (phiSessionId) {
          input.options.runners.reportRemoteKernelDeployment(phiSessionId, progress)
        }
      },
      hello: {
        client: { name: 'phi-desktop', version: paths.version ?? '0.0.0' },
        hostCapabilities: [...input.context.hostCapabilities],
        ...(input.context.afterSeq > 0 ? { takeover: true } : {})
      },
      modelAccess: remoteModelAccess(proxy)
    })
    const close = async (): Promise<void> => {
      input.active.delete(close)
      await Promise.allSettled([
        launched!.close(),
        proxy!.tunnel.close(),
        proxy!.cursorTunnel?.close(),
        proxy!.gateway.close(),
        target.session.close(),
        target.workspace.close?.()
      ])
    }
    input.active.add(close)
    // A dropped forward or lease would leave the kernel calling a dead port; ending the connection
    // lets the execution host reconnect with fresh ones.
    for (const ended of [proxy.tunnel.closed, proxy.cursorTunnel?.closed, proxy.gateway.closed]) {
      void ended?.then(() => launched?.close()).catch(() => undefined)
    }
    return {
      client: launched.client,
      greeting: launched.greeting,
      configuredBeforeHello: true,
      runtimeRoot: launched.deployment.runtimeRoot,
      planHistory: (candidate) => remoteHistoryPlan(target, input.signal, candidate),
      close
    }
  } catch (error) {
    await Promise.allSettled([
      launched?.close(),
      proxy?.tunnel.close(),
      proxy?.cursorTunnel?.close(),
      proxy?.gateway.close(),
      target.session.close(),
      target.workspace.close?.()
    ])
    throw error
  }
}

function createAppLocalKernelLauncher(
  options: AppRemoteSessionRoutingOptions,
  active: Set<() => Promise<void>>,
  modelAccess: { owner?: DesktopModelAccessOwner }
): KernelSessionLauncher {
  return async (params, context, signal) => {
    signal.throwIfAborted()
    modelAccess.owner ??= createDesktopModelAccessOwner(params.agentDir, getPhiEngineBridge())
    const paths = options.appPaths()
    const target = localKernelTarget()
    const buildDirectory = kernelBuildDirectory(paths, target)
    const adoptRoots = [
      params.agentDir,
      ...(params.sessionManager.path && isAbsolute(params.sessionManager.path)
        ? [dirname(params.sessionManager.path)]
        : [])
    ]
    const common = {
      agentDir: params.agentDir,
      home: homedir(),
      cwd: kernelLaunchCwd(paths, buildDirectory),
      onDiagnostic: (text: string) => logKernelDiagnostic('local', text),
      env: {
        ...process.env,
        PHI_KERNEL_ADOPT_ROOTS: [...new Set(adoptRoots)].join(delimiter)
      },
      configureClient: context.configureClient,
      modelAccessBroker: modelAccess.owner.broker,
      hello: {
        client: { name: 'phi-desktop', version: paths.version ?? '0.0.0' },
        hostCapabilities: Array.from(context.hostCapabilities)
      }
    }
    const launched = paths.isPackaged
      ? await launchLocalKernel({
          ...common,
          package: {
            directory: buildDirectory,
            target,
            phiVersion: paths.version ?? '0.0.0'
          }
        })
      : await launchLocalKernel({
          ...common,
          sourceMode: true,
          entry: join(paths.appPath, 'src', 'kernel', 'main.ts')
        })
    const close = async (): Promise<void> => {
      active.delete(close)
      await launched.close()
    }
    active.add(close)
    return {
      client: launched.client,
      greeting: launched.greeting,
      configuredBeforeHello: true,
      close
    }
  }
}

export function createAppKernelSessionLaunchers(
  options: AppRemoteSessionRoutingOptions,
  dependencies: AppRemoteSessionRoutingDependencies
): {
  launchLocal: KernelSessionLauncher
  launchRemote: KernelSessionLauncher
  hostCapabilities: readonly string[]
  configureClient: NonNullable<
    import('./engine/kernel-session-factory').KernelSessionFactoryOptions['configureClient']
  >
  close(): Promise<void>
} {
  const modelAccess: { owner?: DesktopModelAccessOwner } = {}
  const active = new Set<() => Promise<void>>()
  const desktopServices = new AppKernelDesktopServices(options, getPhiEngineBridge())
  const launchLocal = createAppLocalKernelLauncher(options, active, modelAccess)

  const launchRemote: KernelSessionLauncher = (params, context, signal) =>
    launchAppRemoteKernel({ options, dependencies, active, params, context, signal })

  return {
    launchLocal,
    launchRemote,
    hostCapabilities: desktopServices.hostCapabilities,
    configureClient: desktopServices.configureClient,
    async close() {
      await Promise.allSettled([...active].map((close) => close()))
      await desktopServices.close()
      modelAccess.owner?.close()
    }
  }
}
