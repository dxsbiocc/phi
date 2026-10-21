import type { DecisionRequest, DecisionResult } from '../../../shared/decisionTypes'
import type { PhiTool } from '../engine/types'
import { validateDecisionRequest, validateDecisionResult } from './validation'

export type DecisionEvaluator = (
  request: DecisionRequest,
  signal?: AbortSignal
) => Promise<DecisionResult>

/** Advisory only: execution, approval and stopping remain under Phi's existing controls. */
export function buildDecisionTool(evaluate: DecisionEvaluator): PhiTool {
  return {
    name: 'phi_decide',
    label: 'Assess a decision',
    site: 'host',
    approval: 'read',
    loadMode: 'essential',
    description:
      'Assess a bounded task-routing, evidence-review or recovery question. Supply relevant evidence and user constraints, plus 2–12 choices with safe unique IDs including an uncertainty option. The result is advisory; it cannot certify success, authorize automatic recovery, launch tasks, grant approvals or stop runs.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['purpose', 'context', 'question', 'options'],
      properties: {
        purpose: { type: 'string', enum: ['task_routing', 'evidence_review', 'recovery'] },
        context: { type: 'string', maxLength: 32768 },
        question: { type: 'string', minLength: 1, maxLength: 4096 },
        options: {
          type: 'array',
          minItems: 2,
          maxItems: 12,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'description'],
            properties: {
              id: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]{0,63}$' },
              description: { type: 'string', minLength: 1, maxLength: 2048 }
            }
          }
        }
      }
    },
    async execute(_toolCallId, params, _update, _context, signal) {
      signal?.throwIfAborted()
      const request = validateDecisionRequest(params)
      const result = validateDecisionResult(await evaluate(request, signal), request)
      signal?.throwIfAborted()
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }
    }
  }
}
