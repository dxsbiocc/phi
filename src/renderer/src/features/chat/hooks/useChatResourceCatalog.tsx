import { useMemo, type ReactNode } from 'react'
import type { ChatResourceMention } from '../../../lib/chatResourceMentions'
import type { PromptAgentSummary, SkillSummary } from '../../../types'
import { useAgentResourceMentions } from './useAgentResourceMentions'

export function useChatResourceCatalog({
  resources,
  skills,
  agents
}: {
  resources?: readonly ChatResourceMention[]
  skills: readonly SkillSummary[]
  agents: readonly PromptAgentSummary[]
}): { resources: readonly ChatResourceMention[]; details: ReactNode } {
  const agentMentions = useAgentResourceMentions(agents)
  const catalog = useMemo(() => {
    const supplied =
      resources ??
      skills.map((skill) => ({
        kind: 'skill' as const,
        id: skill.id,
        name: skill.name,
        icon: skill.icon
      }))
    return [
      ...supplied,
      ...agentMentions.resources.filter(
        (agent) =>
          !supplied.some((resource) => resource.kind === agent.kind && resource.id === agent.id)
      )
    ]
  }, [agentMentions.resources, resources, skills])
  return { resources: catalog, details: agentMentions.details }
}
