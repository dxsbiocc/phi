import type { ResourceIconRef } from './resourceIconTypes'

export interface PromptAgentSummary {
  icon?: ResourceIconRef
  id: string
  name: string
  description: string
  source: string
  trigger: string
}
