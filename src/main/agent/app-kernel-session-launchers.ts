import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'

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
import type { DesktopModelAccessOwner } from './engine/kernel-host/desktop-model-access'
import type { RemoteReverseTunnel } from './wrappers/remote-ssh-session'
import { facadeBindingHash } from './engine/rpc/facade-session-driver'
import { probeRemoteKernelHistory, readAndPlanKernelHistory } from './engine/kernel-history'
import { getSessionDir } from './session/session-store'
import { AppKernelDesktopServices } from './app-kernel-desktop-services'
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

let kernelModelGatewayGeneration = 0

type OwnedModelGatewayLease = Awaited<ReturnType<PhiEngineBridge['createModelGatewayLease']>>

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

async function openRemoteModelProxy(
  params: PhiSessionCreateParams,
  target: RemoteTarget,
  signal: AbortSignal
): Promise<{ gateway: OwnedModelGatewayLease; tunnel: RemoteReverseTunnel }> {
  const catalog = (await getPhiEngine().models.snapshot({ agentDir: params.agentDir })).models
    .filter((model) => model.provider !== 'cursor')
    .map((model) => ({ provider: model.provider, id: model.id }))
  if (!catalog.length) throw new Error('Remote kernel needs at least one proxy model.')
  const gateway = await getPhiEngineBridge().createModelGatewayLease(
    {
      sessionId: `kernel-${target.remote.location.hostProfileId}`,
      generation: ++kernelModelGatewayGeneration,
      models: catalog
    },
    signal
  )
  try {
    const tunnel = await target.session.openReverseTunnel!({
      localPort: gateway.localPort,
      signal
    })
    return { gateway, tunnel }
  } catch (error) {
    await gateway.close()
    throw error
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
  let proxy: Awaited<ReturnType<typeof openRemoteModelProxy>> | undefined
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
      hello: {
        client: { name: 'phi-desktop', version: paths.version ?? '0.0.0' },
        hostCapabilities: [...input.context.hostCapabilities],
        ...(input.context.afterSeq > 0 ? { takeover: true } : {})
      },
      modelAccess: {
        endpoint: `http://127.0.0.1:${proxy.tunnel.remotePort}/v1/pi/stream`,
        bearerToken: proxy.gateway.bearerToken,
        models: proxy.gateway.models
      }
    })
    const close = async (): Promise<void> => {
      input.active.delete(close)
      await Promise.allSettled([
        launched!.close(),
        proxy!.tunnel.close(),
        proxy!.gateway.close(),
        target.session.close(),
        target.workspace.close?.()
      ])
    }
    input.active.add(close)
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
    // Loaded on first launch: the SDK credential store cannot load in node-run shared modules.
    const { createDesktopModelAccessOwner } =
      await import('./engine/kernel-host/desktop-model-access')
    modelAccess.owner ??= await createDesktopModelAccessOwner(params.agentDir)
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
      cwd: paths.appPath,
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
