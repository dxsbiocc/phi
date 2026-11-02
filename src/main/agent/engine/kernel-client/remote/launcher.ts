import { createHash } from 'node:crypto'
import { shellQuote, type RemoteSshSession } from '../../../wrappers/remote-ssh-session'
import type { HostCapabilityProfile } from '../../../workspace-host/types'
import {
  remoteHelperReadyMarkerSha256,
  type RemoteHelperInstallation
} from '../../../remote-helper-marker'
import type {
  KernelEventFrame,
  KernelHelloResult,
  JsonValue,
  ModelAccessConfigureParams
} from '../../../../../shared/kernel-protocol'
import { KernelProtocolClient, subscribeReportingReplayGap } from '..'
import {
  ensureRemoteKernelDeployment,
  probeRemoteKernelHostProfile,
  remoteKernelHostFromSshSession
} from './deployment'
import { RemoteKernelTransport, type RemoteKernelAttachStatus } from './transport'
import {
  RemoteKernelError,
  type RemoteKernelDeployment,
  type RemoteKernelDeploymentHost,
  type RemoteKernelDeploymentOptions,
  type RemoteKernelProfile
} from './types'

const RESERVED_ENV = new Set(['HOME', 'PI_CODING_AGENT_DIR', 'PI_NATIVES_DIR', 'PATH'])
const REQUIRED_ATTACH_HELPER_VERSION = '0.4.0'

export interface LaunchRemoteKernelOptions {
  readonly session: Pick<
    RemoteSshSession,
    'openStdio' | 'exec' | 'execWithInput' | 'execBounded' | 'uploadFile' | 'remoteHelper'
  >
  readonly runtimeRoot: string
  readonly buildDirectory: string
  readonly runtimeHost?: RemoteKernelDeploymentHost
  /** Required only when runtimeHost is omitted. */
  readonly profile?: HostCapabilityProfile
  /** Optional per-run isolated paths; callers create and own their contents. */
  readonly home?: string
  readonly agentDir?: string
  readonly signal?: AbortSignal
  readonly uploadOptions?: RemoteKernelDeploymentOptions['uploadOptions']
  readonly onProgress?: RemoteKernelDeploymentOptions['onProgress']
  readonly environment?: Readonly<Record<string, string>>
  readonly onDiagnostic?: (text: string) => void
  /** Register desktop host capabilities before hello advertises them. */
  readonly configureClient?: (client: KernelProtocolClient) => void
  readonly hello?: Parameters<KernelProtocolClient['hello']>[0]
  /** Fresh reverse-tunnel route installed immediately after hello. */
  readonly modelAccess?:
    | ModelAccessConfigureParams
    | (() => ModelAccessConfigureParams | Promise<ModelAccessConfigureParams>)
  readonly helloTimeoutMs?: number
  readonly graceMs?: number
}

export interface LaunchedRemoteKernel {
  readonly client: KernelProtocolClient
  readonly greeting: KernelHelloResult
  readonly deployment: RemoteKernelDeployment
  readonly profile: RemoteKernelProfile
  readonly homePath: string
  readonly agentDir: string
  /** Connection-scoped stdio open through completed kernel.hello. */
  readonly readyMs: number
  /** Whether this attach reused the live kernel or won the spawn lock. */
  readonly attach: RemoteKernelAttachStatus
  readonly helper: RemoteHelperInstallation
  /** Deployment exec commands plus the connection-scoped stdio channel. */
  readonly remoteCommandCount: number
  close(): Promise<void>
}

export type RemoteKernelLauncher = LaunchedRemoteKernel

export interface ReattachRemoteKernelOptions {
  readonly session: Pick<RemoteSshSession, 'openStdio'>
  readonly previous: LaunchedRemoteKernel
  readonly lastSeen: number
  readonly signal?: AbortSignal
  readonly environment?: Readonly<Record<string, string>>
  readonly onDiagnostic?: (text: string) => void
  /** Installed before takeover hello so reconnect-time events cannot race listener setup. */
  readonly onEvent?: (event: KernelEventFrame) => void
  /** Register host handlers here before takeover advertises their hello capabilities. */
  readonly configureClient?: (client: KernelProtocolClient) => void
  readonly hello?: Omit<Parameters<KernelProtocolClient['hello']>[0], 'takeover'>
  /** A reattach normally has a new tunnel port, so resolve this after its hello. */
  readonly modelAccess?:
    | ModelAccessConfigureParams
    | (() => ModelAccessConfigureParams | Promise<ModelAccessConfigureParams>)
  readonly helloTimeoutMs?: number
}

export interface ReattachedRemoteKernel extends LaunchedRemoteKernel {
  readonly snapshotRequired: boolean
}

interface OpenRemoteKernelClientOptions {
  readonly session: Pick<RemoteSshSession, 'openStdio'>
  readonly command: string
  readonly hello: Parameters<KernelProtocolClient['hello']>[0]
  readonly helloTimeoutMs: number
  readonly onDiagnostic?: (text: string) => void
  readonly configureClient?: (client: KernelProtocolClient) => void
  readonly modelAccess?:
    | ModelAccessConfigureParams
    | (() => ModelAccessConfigureParams | Promise<ModelAccessConfigureParams>)
  readonly openFailureMessage: string
  readonly helloFailureMessage: string
}

interface OpenedRemoteKernelClient {
  readonly client: KernelProtocolClient
  readonly greeting: KernelHelloResult
  readonly attach: RemoteKernelAttachStatus
  readonly readyMs: number
}

function modelAccessWireParams(configuration: ModelAccessConfigureParams): JsonValue {
  return {
    endpoint: configuration.endpoint,
    bearerToken: configuration.bearerToken,
    models: configuration.models.map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: [...model.input],
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      ...(model.cost ? { cost: { ...model.cost } } : {})
    })),
    ...(configuration.cursor ? { cursor: { ...configuration.cursor } } : {})
  }
}

function explicitEnvironment(
  deployment: RemoteKernelDeployment,
  additions: Readonly<Record<string, string>> = {},
  paths: { readonly home?: string; readonly agentDir?: string } = {}
): Readonly<Record<string, string>> {
  for (const [name, value] of Object.entries(additions)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || /[\0\r\n]/.test(value)) {
      throw new RemoteKernelError('INVALID_ARGUMENT', `Invalid remote kernel environment: ${name}.`)
    }
    if (RESERVED_ENV.has(name)) {
      throw new RemoteKernelError(
        'INVALID_ARGUMENT',
        `Remote kernel environment cannot override ${name}.`
      )
    }
  }
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: paths.home ?? deployment.homePath,
    PI_CODING_AGENT_DIR: paths.agentDir ?? deployment.agentDir,
    OMP_APP_NAME: 'Phi',
    ...additions
  }
}

/**
 * The socket is shared per runtime root and kernel identity. Including the build
 * hash keeps a redeployed build of the same Phi version from attaching to the
 * previous build's still-running kernel.
 */
export function kernelSocketIdentity(
  deployment: {
    readonly phiVersion: string
    readonly kernelSha256: string
  },
  runtime?: { readonly home: string; readonly agentDir: string }
): string {
  const runtimeSuffix = runtime
    ? `+${createHash('sha256')
        .update(runtime.home)
        .update('\0')
        .update(runtime.agentDir)
        .digest('hex')
        .slice(0, 12)}`
    : ''
  return `${deployment.phiVersion}+${deployment.kernelSha256.slice(0, 12)}${runtimeSuffix}`
}

export function assertRemoteKernelRuntimeIdentity(
  greeting: KernelHelloResult,
  expected: { readonly home: string; readonly agentDir: string }
): void {
  // Empty values exist only in older in-memory protocol fixtures. Every real K4 kernel reports
  // both fields from its trusted process environment.
  if (!greeting.runtime.home && !greeting.runtime.agentDir) return
  if (greeting.runtime.home !== expected.home || greeting.runtime.agentDir !== expected.agentDir) {
    throw new RemoteKernelError(
      'LAUNCH_FAILED',
      'Attached kernel HOME or agent directory does not match the selected host profile.'
    )
  }
}
export function buildRemoteKernelLaunchCommand(
  deployment: RemoteKernelDeployment,
  helper: RemoteHelperInstallation,
  environment?: Readonly<Record<string, string>>,
  paths?: { readonly home?: string; readonly agentDir?: string },
  graceMs?: number
): string {
  if (!validAttachHelper(helper)) {
    throw new RemoteKernelError(
      'HELPER_UNAVAILABLE',
      `Remote kernel requires marker-backed phi-helper ${REQUIRED_ATTACH_HELPER_VERSION}.`
    )
  }
  for (const [label, value] of [
    ['home', paths?.home],
    ['agentDir', paths?.agentDir]
  ] as const) {
    if (
      value !== undefined &&
      (!value.startsWith('/') || value === '/' || /[\0\r\n]/.test(value))
    ) {
      throw new RemoteKernelError('INVALID_ARGUMENT', `Remote kernel ${label} must be absolute.`)
    }
  }
  const explicit = explicitEnvironment(deployment, environment, paths)
  if (graceMs !== undefined && (!Number.isSafeInteger(graceMs) || graceMs <= 0)) {
    throw new RemoteKernelError('INVALID_ARGUMENT', 'Kernel grace period must be positive.')
  }
  const helperArguments = [
    shellQuote(helper.remotePath),
    'attach',
    '--kernel',
    shellQuote(deployment.executablePath),
    '--runtime-root',
    shellQuote(deployment.runtimeRoot),
    '--kernel-version',
    shellQuote(
      kernelSocketIdentity(deployment, {
        home: explicit.HOME,
        agentDir: explicit.PI_CODING_AGENT_DIR
      })
    ),
    ...(graceMs === undefined ? [] : ['--grace-ms', String(graceMs)]),
    ...Object.entries(explicit).flatMap(([name, value]) => [
      '--env',
      shellQuote(`${name}=${value}`)
    ])
  ]
  // The helper receives only a minimal PATH. The detached kernel receives only the
  // explicit --env entries; PI_NATIVES_DIR therefore cannot redirect its verified addon.
  return `umask 077 && cd -- ${shellQuote(explicit.HOME)} && exec env -i PATH='/usr/local/bin:/usr/bin:/bin' ${helperArguments.join(' ')}`
}

function validAttachHelper(
  helper: RemoteHelperInstallation | undefined
): helper is RemoteHelperInstallation {
  return Boolean(
    helper &&
    helper.markerIdentity.kind === 'remote-helper' &&
    helper.markerIdentity.version === REQUIRED_ATTACH_HELPER_VERSION &&
    helper.remotePath.startsWith('/') &&
    helper.remoteDirectory.startsWith('/') &&
    helper.remotePath === `${helper.remoteDirectory}/phi-helper` &&
    helper.readyMarkerPath === `${helper.remoteDirectory}/.phi-ready.json` &&
    /^[a-f0-9]{64}$/.test(helper.markerIdentity.sha256) &&
    helper.readyMarkerSha256 === remoteHelperReadyMarkerSha256(helper.markerIdentity)
  )
}

async function resolveAttachHelper(
  options: LaunchRemoteKernelOptions,
  runtimeHost: RemoteKernelDeploymentHost
): Promise<RemoteHelperInstallation> {
  let helper = runtimeHost.managedRemoteHelper?.() ?? options.session.remoteHelper
  if (runtimeHost.ensureManagedRemoteHelper) {
    helper = await runtimeHost.ensureManagedRemoteHelper()
    if (!validAttachHelper(helper)) {
      helper = await runtimeHost.ensureManagedRemoteHelper({ force: true })
    }
  }
  if (!validAttachHelper(helper)) {
    const reason = runtimeHost.managedRemoteHelperFailure?.()
    throw new RemoteKernelError(
      'HELPER_UNAVAILABLE',
      `Remote kernel requires marker-backed phi-helper ${REQUIRED_ATTACH_HELPER_VERSION}${reason ? `: ${reason}` : '.'}`
    )
  }
  return helper
}

// A first start reads the kernel and its addon from a shared disk, on servers already under load.
const REMOTE_HELLO_TIMEOUT_MS = 60_000

function assertHelloTimeout(helloTimeoutMs: number): void {
  if (!Number.isFinite(helloTimeoutMs) || helloTimeoutMs <= 0) {
    throw new RemoteKernelError('INVALID_ARGUMENT', 'Kernel hello timeout must be positive.')
  }
}

async function openRemoteKernelClient(
  options: OpenRemoteKernelClientOptions
): Promise<OpenedRemoteKernelClient> {
  if (!options.session.openStdio) {
    throw new RemoteKernelError(
      'STDIO_UNAVAILABLE',
      'Connected SSH session has no persistent stdio capability.'
    )
  }
  const readyStarted = performance.now()
  let channel
  try {
    channel = await options.session.openStdio(options.command)
  } catch (error) {
    throw new RemoteKernelError('LAUNCH_FAILED', options.openFailureMessage, { cause: error })
  }
  const transport = new RemoteKernelTransport(channel, options.onDiagnostic)
  const client = new KernelProtocolClient(transport)
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    options.configureClient?.(client)
    const opened = await Promise.race([
      Promise.all([client.hello(options.hello), transport.attachStatus]),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Kernel hello timed out after ${options.helloTimeoutMs} ms.`)),
          options.helloTimeoutMs
        )
        timeout.unref()
      })
    ])
    if (options.modelAccess) {
      const configuration =
        typeof options.modelAccess === 'function'
          ? await options.modelAccess()
          : options.modelAccess
      await client.request('modelAccess.configure', modelAccessWireParams(configuration))
    }
    return {
      client,
      greeting: opened[0],
      attach: opened[1],
      readyMs: performance.now() - readyStarted
    }
  } catch (error) {
    await client.close().catch(() => undefined)
    const reason = error instanceof Error ? error.message : String(error)
    throw new RemoteKernelError('LAUNCH_FAILED', `${options.helloFailureMessage} ${reason}`, {
      cause: error
    })
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export async function launchRemoteKernel(
  options: LaunchRemoteKernelOptions
): Promise<LaunchedRemoteKernel> {
  options.signal?.throwIfAborted()
  const helloTimeoutMs = options.helloTimeoutMs ?? REMOTE_HELLO_TIMEOUT_MS
  assertHelloTimeout(helloTimeoutMs)
  let platformProbeCommandCount = 0
  let profile = options.profile ?? options.runtimeHost?.capabilities()
  if (!profile) {
    profile = await probeRemoteKernelHostProfile(options.session, options.signal)
    platformProbeCommandCount = 1
  }
  const runtimeHost =
    options.runtimeHost ?? remoteKernelHostFromSshSession(options.session, profile)
  const deployment = await ensureRemoteKernelDeployment({
    runtimeHost,
    runtimeRoot: options.runtimeRoot,
    buildDirectory: options.buildDirectory,
    signal: options.signal,
    onProgress: options.onProgress,
    uploadOptions: options.uploadOptions
  })
  options.signal?.throwIfAborted()
  const helper = await resolveAttachHelper(options, runtimeHost)
  const command = buildRemoteKernelLaunchCommand(
    deployment,
    helper,
    options.environment,
    { home: options.home, agentDir: options.agentDir },
    options.graceMs
  )
  const opened = await openRemoteKernelClient({
    session: options.session,
    command,
    hello: options.hello ?? {},
    helloTimeoutMs,
    onDiagnostic: options.onDiagnostic,
    configureClient: options.configureClient,
    modelAccess: options.modelAccess,
    openFailureMessage: 'Failed to open remote kernel stdio.',
    helloFailureMessage: 'Remote kernel hello failed.'
  })
  const homePath = options.home ?? deployment.homePath
  const agentDir = options.agentDir ?? deployment.agentDir
  try {
    assertRemoteKernelRuntimeIdentity(opened.greeting, { home: homePath, agentDir })
  } catch (error) {
    await opened.client.close().catch(() => undefined)
    throw error
  }
  return {
    client: opened.client,
    greeting: opened.greeting,
    attach: opened.attach,
    helper,
    deployment,
    profile: deployment.profile,
    homePath,
    agentDir,
    readyMs: opened.readyMs,
    remoteCommandCount: platformProbeCommandCount + deployment.remoteCommandCount + 1,
    close: () => opened.client.close()
  }
}

export async function reattachRemoteKernel(
  options: ReattachRemoteKernelOptions
): Promise<ReattachedRemoteKernel> {
  options.signal?.throwIfAborted()
  if (!Number.isSafeInteger(options.lastSeen) || options.lastSeen < 0) {
    throw new RemoteKernelError('INVALID_ARGUMENT', 'Last seen kernel event sequence is invalid.')
  }
  const helloTimeoutMs = options.helloTimeoutMs ?? REMOTE_HELLO_TIMEOUT_MS
  assertHelloTimeout(helloTimeoutMs)
  const command = buildRemoteKernelLaunchCommand(
    options.previous.deployment,
    options.previous.helper,
    options.environment,
    { home: options.previous.homePath, agentDir: options.previous.agentDir }
  )
  const opened = await openRemoteKernelClient({
    session: options.session,
    command,
    hello: { ...options.hello, takeover: true },
    helloTimeoutMs,
    onDiagnostic: options.onDiagnostic,
    configureClient(client) {
      options.configureClient?.(client)
      if (options.onEvent) client.onEvent(options.onEvent)
    },
    modelAccess: options.modelAccess,
    openFailureMessage: 'Failed to re-open remote kernel stdio.',
    helloFailureMessage: 'Remote kernel reattach failed.'
  })
  try {
    assertRemoteKernelRuntimeIdentity(opened.greeting, {
      home: options.previous.homePath,
      agentDir: options.previous.agentDir
    })
    let snapshotRequired =
      opened.attach.state === 'spawned' ||
      opened.greeting.kernelInstanceId !== options.previous.greeting.kernelInstanceId
    if (!snapshotRequired) {
      snapshotRequired = await subscribeReportingReplayGap(opened.client, options.lastSeen)
    }
    return {
      client: opened.client,
      greeting: opened.greeting,
      deployment: options.previous.deployment,
      profile: options.previous.profile,
      homePath: options.previous.homePath,
      agentDir: options.previous.agentDir,
      helper: options.previous.helper,
      attach: opened.attach,
      snapshotRequired,
      readyMs: opened.readyMs,
      remoteCommandCount: 1,
      close: () => opened.client.close()
    }
  } catch (error) {
    await opened.client.close().catch(() => undefined)
    throw new RemoteKernelError('LAUNCH_FAILED', 'Remote kernel reattach failed.', { cause: error })
  }
}
