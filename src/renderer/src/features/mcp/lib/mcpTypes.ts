import type { ResourceIconRef } from '../../../../../shared/resourceIconTypes'
import type {
  FeaturedMcpConnector,
  LocalMcpConnectorRequest,
  LocalMcpRuntimeOption,
  McpConnectorSetupProgress,
  RemoteMcpConnectorOptions
} from '../../../../../shared/mcpConnectorCatalog'
import type { InstalledPackageView } from '../../../../../shared/packageManagerTypes'

export interface McpServerSummary {
  icon?: ResourceIconRef
  id: string
  name: string
  /** Catalog title of the connector this server came from, when known. */
  title?: string
  connectorId?: string
  packageId?: string
  category?: string
  command?: string
  args?: string[]
  envKeys?: string[]
  url?: string
  transport?: string
  sourcePath?: string
  managed?: boolean
  userStdio?: boolean
  enabled?: boolean
  userDisabled?: boolean
  status: 'configured'
}

export interface McpRendererApi {
  listMcpServers: (cwd?: string) => Promise<McpServerSummary[]>
  listMcpConnectorCatalog: () => Promise<FeaturedMcpConnector[]>
  installMcpConnector: (
    id: string,
    version?: string,
    registryDir?: string
  ) => Promise<InstalledPackageView[]>
  uninstallMcpConnector: (id: string) => Promise<InstalledPackageView[]>
  buildMcpConnectorEnvironment: (id: string) => Promise<{ envId: string }>
  onMcpConnectorSetupChanged: (cb: (progress: McpConnectorSetupProgress) => void) => () => void
  addRemoteMcpConnector: (
    name: string,
    url: string,
    options?: RemoteMcpConnectorOptions
  ) => Promise<void>
  addLocalMcpConnector: (request: LocalMcpConnectorRequest) => Promise<{ tools: string[] }>
  startLocalConnectorAdd: (
    request: LocalMcpConnectorRequest
  ) => Promise<{ started: true; name: string }>
  cancelLocalConnectorAdd: (name: string) => Promise<void>
  retryLocalConnectorAdd: (name: string) => Promise<{ started: true; name: string }>
  listLocalConnectorJobs: () => Promise<McpConnectorSetupProgress[]>
  removeLocalMcpConnector: (name: string) => Promise<void>
  listLocalMcpRuntimes: () => Promise<LocalMcpRuntimeOption[]>
  authorizeRemoteMcpConnector: (name: string) => Promise<void>
  cancelRemoteMcpAuth: (name: string) => Promise<void>
  removeRemoteMcpConnector: (name: string, url: string) => Promise<void>
  setMcpConnectorEnabled: (name: string, enabled: boolean, sourcePath?: string) => Promise<void>
  listFeaturedMcpTools: (id: string) => Promise<string[]>
  getFeaturedMcpAuthStatus: (id: string) => Promise<boolean>
  authorizeFeaturedMcp: (id: string) => Promise<void>
  cancelFeaturedMcpAuth: (id: string) => Promise<void>
  getFeaturedMcpApiKeyStatus: (id: string) => Promise<boolean>
  setFeaturedMcpApiKey: (id: string, key: string) => Promise<void>
  clearFeaturedMcpApiKey: (id: string) => Promise<void>
}
