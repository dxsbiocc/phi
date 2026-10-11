import type { ResourceIconRef } from './resourceIconTypes'

export type PromptAgentTrustState = 'pending' | 'trusted' | 'changed' | 'invalid'

export interface RemoteProjectAgentTrustRequest {
  cwd: string
  relativePath: string
  contentHash: string
}

export interface PromptAgentSummary {
  icon?: ResourceIconRef
  id: string
  name: string
  description: string
  source: string
  trigger: string
  scope?: 'local' | 'remote-project'
  trustState?: PromptAgentTrustState
  available?: boolean
  diagnostics?: string[]
  relativePath?: string
  contentHash?: string
}
