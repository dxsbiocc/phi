import { randomUUID } from 'node:crypto'
import type { PhiEngine } from './types'
import type { OmpBridge } from './omp-bridge'
import {
  validateDecisionRequest,
  validateDecisionModel,
  validateDecisionResult
} from '../decisions/validation'

export const DECISION_TIMEOUT_MS = 45_000

/** A bridge abort drops a reply only; a separate private job cancellation stops its provider. */
export function createDecisionClient(
  bridge: Pick<OmpBridge, 'request'>,
  timeoutMs = DECISION_TIMEOUT_MS
): PhiEngine['decisions'] {
  return {
    models: (params) => bridge.request('decisions.models', params),
    async evaluate(params, signal) {
      signal?.throwIfAborted()
      const request = validateDecisionRequest(params.request)
      const model = validateDecisionModel(params.model)
      const jobId = randomUUID()
      const controller = new AbortController()
      const cancel = (): void => {
        if (controller.signal.aborted) return
        controller.abort(signal?.aborted ? signal.reason : new Error('Decision deadline exceeded'))
        void bridge
          .request('decisions.cancel', { jobId }, { timeoutMs: 5_000 })
          .catch(() => undefined)
      }
      signal?.addEventListener('abort', cancel, { once: true })
      const timer = setTimeout(cancel, timeoutMs)
      try {
        if (signal?.aborted) cancel()
        controller.signal.throwIfAborted()
        const result = await bridge.request(
          'decisions.evaluate',
          { ...params, model, request, jobId },
          { signal: controller.signal }
        )
        controller.signal.throwIfAborted()
        return validateDecisionResult(result, request)
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', cancel)
      }
    }
  }
}
