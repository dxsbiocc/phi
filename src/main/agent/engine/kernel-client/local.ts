import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import type { KernelHelloResult } from '../../../../shared/kernel-protocol'
import { KernelProtocolClient } from '.'
import {
  MODEL_ACCESS_BROKER_CAPABILITIES,
  registerModelAccessBroker,
  type ModelAccessBroker
} from '../kernel-host/model-access-broker'
import {
  spawnKernelStdio,
  type LocalKernelCloseOutcome,
  type SpawnKernelStdioOptions
} from './stdio'
import { verifyLocalKernelPackage, type LocalKernelPackageTarget } from './local-package'

type LaunchLocalKernelCommonOptions = {
  agentDir: string
  home?: string
  env?: NodeJS.ProcessEnv
  cwd?: string
  onDiagnostic?: (text: string) => void
  hello?: Parameters<KernelProtocolClient['hello']>[0]
  /** Register trusted desktop host services before hello advertises them. */
  configureClient?: (client: KernelProtocolClient) => void
  /** Desktop-owned credential service for the local kernel. */
  modelAccessBroker?: ModelAccessBroker
  helloTimeoutMs?: number
}

export type LaunchLocalKernelOptions = LaunchLocalKernelCommonOptions &
  (
    | {
        sourceMode: true
        executable?: never
        bunExecutable?: string
        bunArgs?: string[]
        entry?: string
      }
    | {
        package: {
          directory: string
          target: LocalKernelPackageTarget
          phiVersion: string
        }
        sourceMode?: false
        executable?: never
        bunExecutable?: never
        bunArgs?: never
        entry?: never
      }
  )

export type LaunchedLocalKernel = {
  client: KernelProtocolClient
  process: ChildProcessWithoutNullStreams
  greeting: KernelHelloResult
  close(): Promise<LocalKernelCloseOutcome>
}

export type LocalKernelLauncher = LaunchedLocalKernel

export async function launchLocalKernel(
  options: LaunchLocalKernelOptions
): Promise<LaunchedLocalKernel> {
  const helloTimeoutMs = options.helloTimeoutMs ?? 10_000
  if (!Number.isFinite(helloTimeoutMs) || helloTimeoutMs <= 0) {
    throw new TypeError('Kernel hello timeout must be a positive number.')
  }
  const env: NodeJS.ProcessEnv = {
    ...(options.env ?? process.env),
    ...(options.home ? { HOME: options.home, USERPROFILE: options.home } : {}),
    PI_CODING_AGENT_DIR: options.agentDir
  }
  const verified =
    'package' in options ? await verifyLocalKernelPackage(options.package) : undefined
  const taggedOutput = process.platform === 'win32'
  const mode: SpawnKernelStdioOptions = verified
    ? {
        executable: verified.executable,
        cwd: options.cwd,
        env,
        taggedOutput,
        onDiagnostic: options.onDiagnostic
      }
    : {
        sourceMode: true,
        cwd: options.cwd,
        env,
        taggedOutput,
        bunExecutable: options.bunExecutable,
        bunArgs: options.bunArgs,
        entry: options.entry,
        onDiagnostic: options.onDiagnostic
      }
  const spawned = spawnKernelStdio(mode)
  try {
    if (options.modelAccessBroker)
      registerModelAccessBroker(spawned.client, options.modelAccessBroker)
    options.configureClient?.(spawned.client)
    const hello = options.modelAccessBroker
      ? {
          ...options.hello,
          hostCapabilities: [
            ...new Set([
              ...(options.hello?.hostCapabilities ?? []),
              ...MODEL_ACCESS_BROKER_CAPABILITIES
            ])
          ]
        }
      : options.hello
    const greeting = await Promise.race([
      spawned.client.hello(hello),
      new Promise<never>((_resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`Kernel hello timed out after ${helloTimeoutMs} ms.`)),
          helloTimeoutMs
        )
        timeout.unref()
      })
    ])
    return { ...spawned, greeting }
  } catch (error) {
    await spawned.close()
    throw error
  }
}

export * from './local-package'
