import { useMemo, useState, type ReactNode } from 'react'

import type { ChatResourceMention } from '../../../lib/chatResourceMentions'
import type { PromptAgentSummary } from '../../../types'
import { AgentReferenceDialog } from '../../agent/components/AgentReferenceDialog'

export function useAgentResourceMentions(agents: readonly PromptAgentSummary[]): {
  resources: ChatResourceMention[]
  details: ReactNode
} {
  const [selected, setSelected] = useState<PromptAgentSummary | null>(null)
  const current = selected && agents.includes(selected) ? selected : null

  if (selected && !current) setSelected(null)

  const resources = useMemo<ChatResourceMention[]>(
    () =>
      agents.map((agent) => ({
        kind: 'agent',
        id: agent.id,
        name: agent.name,
        icon: agent.icon,
        available: agent.available,
        onOpen: () => setSelected(agent)
      })),
    [agents]
  )

  return {
    resources,
    details: current ? (
      <AgentReferenceDialog agent={current} onClose={() => setSelected(null)} />
    ) : null
  }
}
