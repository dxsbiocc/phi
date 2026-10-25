import path from 'node:path'
import { fileURLToPath } from 'node:url'

import packageJson from '../../package.json' with { type: 'json' }

import { readOmpVersion } from './omp/version'
import { KernelProtocolCore } from './protocol'
import { StdioFrameTransport } from './transports/stdio'

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

export function startKernelStdio(): void {
  const transport = new StdioFrameTransport(process.stdin, process.stdout)
  const core = new KernelProtocolCore({
    kernelVersion: readKernelVersion(),
    ompVersion: readOmpVersion(),
    handlers: {}
  })
  core.attachTransport(transport, { connectionId: 'stdio', trusted: true })

  let shutdownStarted = false
  transport.onClose(() => {
    if (shutdownStarted) return
    shutdownStarted = true
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

const entry = process.argv[1]
if (entry && fileURLToPath(import.meta.url) === path.resolve(entry)) startKernelStdio()
