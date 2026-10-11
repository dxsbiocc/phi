export type RemoteProjectMcpTrustState = 'pending' | 'trusted' | 'changed' | 'invalid'

export type RemoteProjectMcpConfirmationKind =
  'https-url' | 'stdio-command' | 'stdio-arg' | 'stdio-env'

export interface RemoteProjectMcpConfirmationItem {
  id: string
  serverName: string
  kind: RemoteProjectMcpConfirmationKind
  value: string
  index?: number
}

export interface RemoteProjectMcpTrustRequest {
  cwd: string
  relativePath: string
  contentHash: string
  confirmedItemIds: string[]
}

export interface RemoteProjectMcpServerSummary {
  id: string
  name: string
  command?: string
  args?: string[]
  envKeys?: string[]
  url?: string
  transport?: string
  sourcePath: string
  enabled?: boolean
  status: 'configured'
  trustState: RemoteProjectMcpTrustState
  available: boolean
  diagnostics: string[]
  relativePath: string
  contentHash: string
  remoteProjectCwd: string
  confirmationItems: RemoteProjectMcpConfirmationItem[]
}

export interface RemoteProjectMcpRuntimeServer {
  name: string
  sourcePath: string
  config: Record<string, unknown>
}
