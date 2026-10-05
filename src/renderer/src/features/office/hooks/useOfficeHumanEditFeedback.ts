import { useCallback, useState } from 'react'

import type { OfficeHumanEditSummary } from '../../../../../shared/officeProtocol'

export function useOfficeHumanEditFeedback(summary: OfficeHumanEditSummary | undefined): Readonly<{
  failure?: OfficeHumanEditSummary
  dismiss: () => void
}> {
  const [dismissed, setDismissed] = useState<OfficeHumanEditSummary | undefined>()
  const dismiss = useCallback(() => setDismissed(summary), [summary])
  return {
    ...(summary?.conclusion === 'failed' && summary !== dismissed ? { failure: summary } : {}),
    dismiss
  }
}
