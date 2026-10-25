import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import type { KernelHelloResult } from '../../../../shared/kernel-protocol'
import { KernelProtocolClient } from '.'
import {
  spawnKernelStdio,
  type LocalKernelCloseOutcome,
  type SpawnKernelStdioOptions
} from './stdio'

type LaunchLocalKernelCommonOptions = {
  agentDir: string
  home?: string
  env?: NodeJS.ProcessEnv
  cwd?: string
  onDiagnostic?: (text: string) => void
  hello?: Parameters<KernelProtocolClient['hello']>[0]
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
        executable: string
        sourceMode?: false
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
  const mode: SpawnKernelStdioOptions = options.executable
    ? { executable: options.executable, cwd: options.cwd, env, onDiagnostic: options.onDiagnostic }
    : {
        sourceMode: true,
        cwd: options.cwd,
        env,
        bunExecutable: options.bunExecutable,
        bunArgs: options.bunArgs,
        entry: options.entry,
        onDiagnostic: options.onDiagnostic
      }
  const spawned = spawnKernelStdio(mode)
  try {
    const greeting = await Promise.race([
      spawned.client.hello(options.hello),
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
