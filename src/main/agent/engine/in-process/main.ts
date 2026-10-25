import { createInterface } from 'node:readline'

import { errorMessage } from '../../../../shared/errorCodes'
import { IncomingRequest, isRecord } from './common'
import {
  createStdoutWorkerOutbound,
  handleHostResponse,
  isHostResponse,
  send,
  setWorkerOutbound
} from './ipc'
import { handleWorkerRequest } from './method-table'
import { closeLoadedWorkerSubsystems } from './worker-subsystems'

setWorkerOutbound(createStdoutWorkerOutbound())

// Bounded so a stuck cleanup cannot keep an orphaned worker alive after the host is gone.
const HOST_EXIT_CLEANUP_TIMEOUT_MS = 1000

let hostExitStarted = false
function shutdownAfterHostExit(): void {
  if (hostExitStarted) return
  hostExitStarted = true
  const cleanup = closeLoadedWorkerSubsystems()
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, HOST_EXIT_CLEANUP_TIMEOUT_MS))
  void Promise.race([cleanup, timeout]).finally(() => process.exit(0))
}

const input = createInterface({ input: process.stdin })
input.once('close', shutdownAfterHostExit)
process.stdin.once('error', shutdownAfterHostExit)
process.stdout.once('error', shutdownAfterHostExit)
input.on('line', (line) => {
  void (async () => {
    let request: IncomingRequest | undefined
    try {
      const message = JSON.parse(line) as unknown
      if (isHostResponse(message)) {
        handleHostResponse(message)
        return
      }
      request = message as IncomingRequest
      const result = await handleWorkerRequest(request.method, request.params)
      send({ id: request.id, ok: true, result })
    } catch (error) {
      const message = errorMessage(error)
      const stack = error instanceof Error ? error.stack : undefined
      const detail =
        isRecord(error) && typeof error.detail === 'string'
          ? error.detail.slice(0, 4096)
          : undefined
      send({ id: request?.id ?? '', ok: false, error: message, stack, detail })
    }
  })()
})
