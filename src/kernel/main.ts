import path from 'node:path'
import { fileURLToPath } from 'node:url'

import packageJson from '../../package.json' with { type: 'json' }

import { parseKernelCommandLine } from './lifecycle/command-line'
import { KernelGracePeriod } from './lifecycle/grace-period'
import { listenOnKernelSocket, type KernelSocketListener } from './lifecycle/socket-listener'
import { readOmpVersion } from './omp/version'
import { KernelProtocolCore, type KernelProtocolLogger } from './protocol'
import { StdioFrameTransport } from './transports/stdio'
import { createWorkerKernelAdapter } from './worker'

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

export function startKernelStdio(): void {
  const transport = new StdioFrameTransport(process.stdin, process.stdout)
  const worker = createWorkerKernelAdapter({
    agentDir: process.env.PI_CODING_AGENT_DIR ?? ''
  })
  const core = new KernelProtocolCore({
    kernelVersion: readKernelVersion(),
    ompVersion: readOmpVersion(),
    handlers: worker.handlers,
    log: stderrLogger
  })
  const unbindWorker = worker.bind(core)
  core.attachTransport(transport, { connectionId: 'stdio', trusted: true })

  let shutdownStarted = false
  transport.onClose(() => {
    if (shutdownStarted) return
    shutdownStarted = true
    unbindWorker()
    const timeout = setTimeout(() => process.exit(0), HOST_EXIT_CLEANUP_TIMEOUT_MS)
    timeout.unref()
    Promise.resolve()
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timeout)
        process.exit(0)
      })
  })
}

export async function startKernelSocket(
  socketPath: string,
  tokenFilePath: string,
  graceMs: number
): Promise<void> {
  const worker = createWorkerKernelAdapter({
    agentDir: process.env.PI_CODING_AGENT_DIR ?? ''
  })
  const graceRef: { value?: KernelGracePeriod } = {}
  let shutdownStarted = false
  const core = new KernelProtocolCore({
    kernelVersion: readKernelVersion(),
    ompVersion: readOmpVersion(),
    handlers: worker.handlers,
    disconnectPolicy: 'wait-for-reconnect',
    controllerLifecycle: {
      onControllerAttached() {
        graceRef.value?.controllerAttached()
      },
      onControllerDetached() {
        graceRef.value?.controllerDetached()
      }
    },
    log: stderrLogger
  })

  const shutdownAfterGrace = async (): Promise<void> => {
    if (shutdownStarted) return
    shutdownStarted = true
    const timeout = setTimeout(() => process.exit(0), HOST_EXIT_CLEANUP_TIMEOUT_MS)
    timeout.unref()
    try {
      try {
        await listener?.close({ removeToken: true })
      } catch (error) {
        writeDiagnostic('error', 'Kernel socket cleanup failed.', {
          error: error instanceof Error ? error.message : String(error)
        })
      }
      await core.expireDisconnectedState()
    } finally {
      unbindWorker()
      clearTimeout(timeout)
      process.exit(0)
    }
  }
  const grace = new KernelGracePeriod({
    graceMs,
    onExpire: shutdownAfterGrace,
    onError(error) {
      writeDiagnostic('error', 'Kernel grace expiry failed.', {
        error: error instanceof Error ? error.message : String(error)
      })
      process.exit(1)
    }
  })
  graceRef.value = grace

  const unbindWorker = worker.bind(core)
  const listener: KernelSocketListener = await listenOnKernelSocket({
    socketPath,
    tokenFilePath,
    onTransport: (transport) => core.attachTransport(transport, { trusted: true })
  }).catch((error: unknown) => {
    unbindWorker()
    throw error
  })
  grace.startDisconnected()
}

const entry = process.argv[1]
if (entry && fileURLToPath(import.meta.url) === path.resolve(entry)) {
  try {
    const command = parseKernelCommandLine(process.argv.slice(2))
    if (command.mode === 'stdio') {
      startKernelStdio()
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
