import type { DecisionEvaluator } from '../decisions/tool'
import type { PhiEngine } from './types'

/** The model selector is injected by the owning session, never supplied by a tool argument. */
export function bindSessionDecisionEvaluator(options: {
  agentDir: string
  sessionId: string
  currentModel(): { provider: string; id: string } | undefined
  evaluate: PhiEngine['decisions']['evaluate']
}): DecisionEvaluator {
  return (request, signal) => {
    signal?.throwIfAborted()
    const model = options.currentModel()
    if (!model) throw new Error('Decision requires an explicitly selected session model')
    return options.evaluate(
      {
        agentDir: options.agentDir,
        sessionId: options.sessionId,
        model: { providerId: model.provider, modelId: model.id },
        request
      },
      signal
    )
  }
}
