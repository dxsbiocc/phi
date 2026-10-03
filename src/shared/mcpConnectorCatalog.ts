export interface FeaturedMcpConnector {
  id: string
  version: string
  name: string
  description: string
  publisher: string
  category: McpConnectorCategory
  signIn: string
  transport: 'http' | 'stdio'
  auth?: 'none' | 'oauth' | 'header'
  url?: string
  environment?: string
  command?: string
  args?: string[]
  homepageUrl?: string
  minAppVersion?: string
  registryDir?: string
  added: boolean
  unavailableReason?: string
  environmentState?: 'ready' | 'not-built'
  /** App-owned presentation copy; connector contract v1 has no long-description field. */
  overview?: string
  /** App-owned OAuth allowlist metadata; never accepted from a registry manifest. */
  oauthAuthorizationOrigin?: string
  /** App-owned API-key transport metadata; never accepted from a registry manifest. */
  apiKey?: { header: string; obtainUrl: string }
}

export const mcpConnectorCategories = [
  '生产力',
  '沟通协作',
  '设计创作',
  '健康与生命科学',
  '科研数据'
] as const

export type McpConnectorCategory = (typeof mcpConnectorCategories)[number]
