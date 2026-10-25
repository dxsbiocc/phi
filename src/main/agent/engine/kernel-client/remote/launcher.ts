import { shellQuote, type RemoteSshSession } from '../../../wrappers/remote-ssh-session'
import type { HostCapabilityProfile } from '../../../workspace-host/types'
import type { KernelHelloResult } from '../../../../../shared/kernel-protocol'
import { KernelProtocolClient } from '..'
import {
  ensureRemoteKernelDeployment,
  probeRemoteKernelHostProfile,
  remoteKernelHostFromSshSession
} from './deployment'
import { RemoteKernelTransport } from './transport'
import {
  RemoteKernelError,
  type RemoteKernelDeployment,
  type RemoteKernelDeploymentHost,
  type RemoteKernelDeploymentOptions,
  type RemoteKernelProfile
} from './types'

const RESERVED_ENV = new Set(['HOME', 'PI_CODING_AGENT_DIR', 'PI_NATIVES_DIR', 'PATH'])

export interface LaunchRemoteKernelOptions {
  readonly session: Pick<
    RemoteSshSession,
    'openStdio' | 'exec' | 'execWithInput' | 'execBounded' | 'uploadFile'
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
  readonly environment?: Readonly<Record<string, string>>
  readonly onDiagnostic?: (text: string) => void
  readonly hello?: Parameters<KernelProtocolClient['hello']>[0]
  readonly helloTimeoutMs?: number
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
  /** Deployment exec commands plus the connection-scoped stdio channel. */
  readonly remoteCommandCount: number
  close(): Promise<void>
}

export type RemoteKernelLauncher = LaunchedRemoteKernel

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

export function buildRemoteKernelLaunchCommand(
  deployment: RemoteKernelDeployment,
  environment?: Readonly<Record<string, string>>,
  paths?: { readonly home?: string; readonly agentDir?: string }
): string {
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
  const assignments = Object.entries(explicit).map(
    ([name, value]) => `${name}=${shellQuote(value)}`
  )
  // env -i is also the explicit guarantee that PI_NATIVES_DIR is unset. The addon
  // loader therefore resolves only the verified sibling file beside process.execPath.
  // Same as the remote OMP launch: files the kernel creates stay private to this OS user.
  return `umask 077 && cd -- ${shellQuote(explicit.HOME)} && exec env -i ${assignments.join(' ')} ${shellQuote(deployment.executablePath)}`
}

export async function launchRemoteKernel(
  options: LaunchRemoteKernelOptions
): Promise<LaunchedRemoteKernel> {
  options.signal?.throwIfAborted()
  const helloTimeoutMs = options.helloTimeoutMs ?? 10_000
  if (!Number.isFinite(helloTimeoutMs) || helloTimeoutMs <= 0) {
    throw new RemoteKernelError('INVALID_ARGUMENT', 'Kernel hello timeout must be positive.')
  }
  if (!options.session.openStdio) {
    throw new RemoteKernelError(
      'STDIO_UNAVAILABLE',
      'Connected SSH session has no persistent stdio capability.'
    )
  }
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
    uploadOptions: options.uploadOptions
  })
  options.signal?.throwIfAborted()
  const command = buildRemoteKernelLaunchCommand(deployment, options.environment, {
    home: options.home,
    agentDir: options.agentDir
  })
  const readyStarted = performance.now()
  let channel
  try {
    channel = await options.session.openStdio(command)
  } catch (error) {
    throw new RemoteKernelError('LAUNCH_FAILED', 'Failed to open remote kernel stdio.', {
      cause: error
    })
  }
  const transport = new RemoteKernelTransport(channel, options.onDiagnostic)
  const client = new KernelProtocolClient(transport)
  let greeting: KernelHelloResult
  try {
    greeting = await Promise.race([
      client.hello(options.hello),
      new Promise<never>((_resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`Kernel hello timed out after ${helloTimeoutMs} ms.`)),
          helloTimeoutMs
        )
        timeout.unref()
      })
    ])
  } catch (error) {
    await client.close().catch(() => undefined)
    throw new RemoteKernelError('LAUNCH_FAILED', 'Remote kernel hello failed.', { cause: error })
  }
  return {
    client,
    greeting,
    deployment,
    profile: deployment.profile,
    homePath: options.home ?? deployment.homePath,
    agentDir: options.agentDir ?? deployment.agentDir,
    readyMs: performance.now() - readyStarted,
    remoteCommandCount: platformProbeCommandCount + deployment.remoteCommandCount + 1,
    close: () => client.close()
  }
}
