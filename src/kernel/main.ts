import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import packageJson from '../../package.json' with { type: 'json' }

import { parseKernelCommandLine } from './lifecycle/command-line'
import { KernelGracePeriod } from './lifecycle/grace-period'
import { listenOnKernelSocket, type KernelSocketListener } from './lifecycle/socket-listener'
import { readOmpVersion } from './omp/version'
import { KernelProtocolCore, type KernelProtocolLogger } from './protocol'
import {
  type ClientProxyModelAccess,
  createClientProxyModelAccess,
  createDesktopBrokerModelAccess,
  ModelAccessWaitCancelledError
} from './model-access'
import { SUPERSEDE_SIGNAL } from './sessions/superseded-writer'
import { StdioFrameTransport } from './transports/stdio'
import { createWorkerKernelAdapter } from './worker'
import type { KernelHostCapabilityResult } from '../shared/kernel-protocol'

const HOST_EXIT_CLEANUP_TIMEOUT_MS = 1_000

type PackageMetadata = {
  version?: unknown
}

function readKernelVersion(): string {
  const metadata: PackageMetadata = packageJson
  if (typeof metadata.version !== 'string' || metadata.version.length === 0) {
    throw new Error('Phi package does not declare a version')
  }
  return metadata.version
}

// stdout carries protocol frames only; diagnostics go to stderr as one JSON line each.
const stderrLogger: KernelProtocolLogger = {
  warn: (message, details) => writeDiagnostic('warn', message, details),
  error: (message, details) => writeDiagnostic('error', message, details)
}

function writeDiagnostic(level: string, message: string, details?: unknown): void {
  process.stderr.write(`${JSON.stringify({ level, message, ...(details ? { details } : {}) })}\n`)
}

function writeErrorDiagnostic(message: string, error: unknown): void {
  writeDiagnostic('error', message, {
    error: error instanceof Error ? error.message : String(error)
  })
}

function remoteControllerLifecycle(
  modelAccess: ClientProxyModelAccess,
  graceRef: { value?: KernelGracePeriod }
): {
  onControllerAttached(): void
  onControllerDetached(): void
} {
  return {
    onControllerAttached() {
      modelAccess.controllerAttached()
      graceRef.value?.controllerAttached()
    },
    onControllerDetached() {
      modelAccess.controllerDetached()
      graceRef.value?.controllerDetached()
    }
  }
}

/**
 * The trusted launcher names the private staging roots `session.adopt` may copy from;
 * a client request can never widen them. Unset means adoption is refused.
 */
function readAdoptSourceRoots(): string[] {
  const raw = process.env.PHI_KERNEL_ADOPT_ROOTS
  if (!raw) return []
  return raw
    .split(path.delimiter)
    .filter((root) => root.length > 0)
    .map((root) => {
      if (!path.isAbsolute(root)) throw new Error('PHI_KERNEL_ADOPT_ROOTS entries must be absolute')
      return root
    })
}

function runtimeIdentity(agentDir: string): { home: string; agentDir: string; pid: number } {
  return { home: process.env.HOME ?? process.env.USERPROFILE ?? '', agentDir, pid: process.pid }
}

export async function startKernelStdio(): Promise<void> {
  const kernelInstanceId = randomUUID()
  const transport = new StdioFrameTransport(process.stdin, process.stdout)
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? ''
  const coreRef: { value?: KernelProtocolCore } = {}
  const modelAccess = await createDesktopBrokerModelAccess({
    hydrate: false,
    modelsPath: path.join(agentDir, 'models.yml'),
    cacheDbPath: ':memory:',
    async requestCredentials(params) {
      if (!coreRef.value) throw new Error('Kernel host controller is not ready.')
      return (await coreRef.value.requestHost(
        'modelAccess.credentials',
        params
      )) as KernelHostCapabilityResult<'modelAccess.credentials'>
    },
    async requestRefresh(params) {
      if (!coreRef.value) throw new Error('Kernel host controller is not ready.')
      return (await coreRef.value.requestHost(
        'modelAccess.refresh',
        params
      )) as KernelHostCapabilityResult<'modelAccess.refresh'>
    }
  })
  const worker = createWorkerKernelAdapter({
    agentDir,
    kernelInstanceId,
    modelAccess,
    allowedSourceRoots: readAdoptSourceRoots()
  })
  const core = new KernelProtocolCore({
    kernelVersion: readKernelVersion(),
    ompVersion: readOmpVersion(),
    kernelInstanceId,
    runtimeIdentity: runtimeIdentity(agentDir),
    handlers: worker.handlers,
    controllerLifecycle: {
      onControllerAttached() {
        modelAccess.controllerAttached?.()
      }
    },
    log: stderrLogger
  })
  coreRef.value = core
  const unbindWorker = worker.bind(core)
  let workerUnbound = false
  const ensureWorkerUnbound = (): void => {
    if (workerUnbound) return
    workerUnbound = true
    unbindWorker()
  }
  core.attachTransport(transport, { connectionId: 'stdio', trusted: true })

  let shutdownStarted = false
  transport.onClose(() => {
    if (shutdownStarted) return
    shutdownStarted = true
    const timeout = setTimeout(() => {
      ensureWorkerUnbound()
      process.exit(0)
    }, HOST_EXIT_CLEANUP_TIMEOUT_MS)
    timeout.unref()
    void worker
      .closeAll()
      .catch((error: unknown) => {
        writeDiagnostic('error', 'Kernel worker cleanup failed.', {
          error: error instanceof Error ? error.message : String(error)
        })
      })
      .finally(() => {
        ensureWorkerUnbound()
        clearTimeout(timeout)
        process.exit(0)
      })
  })
}

/**
 * A newer kernel build needs a session this one holds. Without a desktop or an active run there
 * is nothing left to finish here, so the grace period ends now.
 */
function releaseWhenSuperseded(
  grace: KernelGracePeriod,
  core: KernelProtocolCore,
  shutdown: () => Promise<void>
): void {
  process.on(SUPERSEDE_SIGNAL, () => {
    if (grace.controllerPresent || core.hasActiveRuns()) return
    void shutdown()
  })
}

export async function startKernelSocket(
  socketPath: string,
  tokenFilePath: string,
  graceMs: number
): Promise<void> {
  const kernelInstanceId = randomUUID()
  const modelAccess = createClientProxyModelAccess()
  const worker = createWorkerKernelAdapter({
    agentDir: process.env.PI_CODING_AGENT_DIR ?? '',
    kernelInstanceId,
    modelAccess,
    allowedSourceRoots: readAdoptSourceRoots()
  })
  const graceRef: { value?: KernelGracePeriod } = {}
  let shutdownStarted = false
  const core = new KernelProtocolCore({
    kernelVersion: readKernelVersion(),
    ompVersion: readOmpVersion(),
    kernelInstanceId,
    runtimeIdentity: runtimeIdentity(process.env.PI_CODING_AGENT_DIR ?? ''),
    handlers: worker.handlers,
    disconnectPolicy: 'wait-for-reconnect',
    controllerLifecycle: remoteControllerLifecycle(modelAccess, graceRef),
    log: stderrLogger
  })

  const shutdownAfterGrace = async (): Promise<void> => {
    if (shutdownStarted) return
    shutdownStarted = true
    const timeout = setTimeout(() => {
      ensureWorkerUnbound()
      process.exit(0)
    }, HOST_EXIT_CLEANUP_TIMEOUT_MS)
    timeout.unref()
    try {
      try {
        await listener?.close({ removeToken: true })
      } catch (error) {
        writeErrorDiagnostic('Kernel socket cleanup failed.', error)
      }
      await core.expireDisconnectedState()
      modelAccess.cancelWaiting(new ModelAccessWaitCancelledError('Model access grace expired.'))
    } finally {
      try {
        await worker.closeAll()
      } finally {
        ensureWorkerUnbound()
        clearTimeout(timeout)
        process.exit(0)
      }
    }
  }
  const grace = new KernelGracePeriod({
    graceMs,
    onExpire: shutdownAfterGrace,
    onError(error) {
      writeErrorDiagnostic('Kernel grace expiry failed.', error)
      process.exit(1)
    }
  })
  graceRef.value = grace
  releaseWhenSuperseded(grace, core, shutdownAfterGrace)

  const unbindWorker = worker.bind(core)
  let workerUnbound = false
  const ensureWorkerUnbound = (): void => {
    if (workerUnbound) return
    workerUnbound = true
    unbindWorker()
  }
  const listener: KernelSocketListener = await listenOnKernelSocket({
    socketPath,
    tokenFilePath,
    onTransport: (transport) => core.attachTransport(transport, { trusted: true })
  }).catch((error: unknown) => {
    ensureWorkerUnbound()
    throw error
  })
  grace.startDisconnected()
}

export function runKernelCommandLine(): void {
  try {
    const command = parseKernelCommandLine(process.argv.slice(2))
    if (command.mode === 'stdio') {
      void startKernelStdio().catch((error: unknown) => {
        writeErrorDiagnostic('Kernel stdio startup failed.', error)
        process.exit(1)
      })
    } else {
      void startKernelSocket(command.socketPath, command.tokenFilePath, command.graceMs).catch(
        (error: unknown) => {
          writeDiagnostic('error', 'Kernel socket listener failed.', {
            error: error instanceof Error ? error.message : String(error)
          })
          process.exit(1)
        }
      )
    }
  } catch (error) {
    writeDiagnostic('error', 'Kernel arguments are invalid.', {
      error: error instanceof Error ? error.message : String(error)
    })
    process.exit(1)
  }
}

// A compiled build starts in omp/compiled-entry.ts. Every module there shares the bundle's
// import.meta.url, so this check would pass as well and start a second kernel on the same stdin.
const entry = process.argv[1]
if (
  process.env.PI_COMPILED !== 'true' &&
  entry &&
  fileURLToPath(import.meta.url) === path.resolve(entry)
) {
  runKernelCommandLine()
}
