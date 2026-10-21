import { randomUUID } from 'node:crypto'
import { readModelAvailability } from '../../model-availability'
import {
  validateDecisionRequest,
  validateDecisionModel,
  validateDecisionResult
} from '../../decisions/validation'
import { DecisionJobs } from '../decision-jobs'
import { evaluateDecision, listDecisionModels } from './decision-backend'
import { selectAutomaticDecisionModel } from './automatic-decision-model'
import type { PhiEngine } from '../types'

const jobs = new DecisionJobs()
type DecisionParams = Parameters<PhiEngine['decisions']['evaluate']>[0]

function jobIdentity(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value))
    throw new Error('Invalid decision job')
  return value
}

/** Config and the caller's explicit current model are copied once at decision invocation. */
export function evaluateDecisionRequest(
  params: DecisionParams & { jobId?: string },
  signal?: AbortSignal
): Promise<ReturnType<typeof validateDecisionResult>> {
  const request = validateDecisionRequest(params.request)
  const model = validateDecisionModel(params.model)
  const availability = readModelAvailability(params.agentDir)
  return jobs.run(
    params.jobId ? jobIdentity(params.jobId) : randomUUID(),
    async (signal) => {
      const judgeModel = await selectAutomaticDecisionModel(params.agentDir, availability, signal)
      const result = await evaluateDecision(
        {
          agentDir: params.agentDir,
          sessionId: params.sessionId,
          model,
          judgeModel,
          request,
          availability
        },
        signal
      )
      return validateDecisionResult(result, request)
    },
    signal
  )
}

export function handleDecisionRequest(method: string, params: unknown): Promise<unknown> | void {
  if (!params || typeof params !== 'object') throw new Error('Invalid decision parameters')
  if (method === 'decisions.cancel') {
    jobs.cancel(jobIdentity((params as { jobId?: unknown }).jobId))
    return
  }
  const input = params as DecisionParams & { jobId?: string }
  if (typeof input.agentDir !== 'string' || !input.agentDir)
    throw new Error('Missing decision agent directory')
  if (method === 'decisions.models') return listDecisionModels(input.agentDir)
  if (method !== 'decisions.evaluate' || typeof input.sessionId !== 'string' || !input.sessionId)
    throw new Error('Invalid decision operation')
  jobIdentity(input.jobId)
  return evaluateDecisionRequest(input)
}

export function closeDecisionRuntime(): void {
  jobs.close()
}
