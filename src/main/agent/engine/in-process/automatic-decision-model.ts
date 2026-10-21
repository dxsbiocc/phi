import { isJudgmentApi } from '@oh-my-pi/pi-ai'
import type { DecisionModelSelection } from '../../../../shared/decisionTypes'
import type { ModelAvailabilitySettings } from '../../../../shared/modelAvailabilityTypes'
import { isModelEnabled } from '../../model-availability'
import { getContext } from './runtime-context'
import type { RuntimeModel } from './common'

function priority(model: RuntimeModel): number {
  if (/(^|\/)jev-latest$/i.test(model.id)) return model.provider === 'typesafe' ? 0 : 1
  if (model.provider === 'typesafe') return 2
  return /(^|[/_-])jev([/_-]|$)/i.test(model.id) ? 3 : 4
}

/** A fresh, credentialed native choice per invocation; no SDK role chain or local downloads. */
export async function selectAutomaticDecisionModel(
  agentDir: string,
  availability: ModelAvailabilitySettings,
  signal: AbortSignal
): Promise<DecisionModelSelection | null> {
  signal.throwIfAborted()
  const { modelRegistry } = await getContext(agentDir)
  signal.throwIfAborted()
  const candidates = modelRegistry
    .getAvailable('judge')
    .filter(
      (model) => isJudgmentApi(model.api) && isModelEnabled(availability, model.provider, model.id)
    )
  candidates.sort((a, b) => {
    const rank = priority(a) - priority(b)
    if (rank) return rank
    const left = `${a.provider}/${a.id}`
    const right = `${b.provider}/${b.id}`
    return left < right ? -1 : left > right ? 1 : 0
  })
  const model = candidates[0]
  return model ? { providerId: model.provider, modelId: model.id } : null
}
